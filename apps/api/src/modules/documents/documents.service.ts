import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { DocumentStatus, ErrorCode, SystemRole, WorkspaceRole } from '@ekh/shared';
import { DocumentEntity } from '../../database/entities/document.entity';
import { WorkspaceEntity } from '../../database/entities/workspace.entity';
import { BizException } from '../../common/filters/http-exception.filter';
import { RedisService } from '../../redis/redis.service';
import { AclService } from '../workspaces/acl.service';
import { AclAlertService } from '../audit/acl-alert.service';
import { IngestionProducer } from '../ingestion/ingestion.producer';
import { StorageService } from './storage.service';
import type { AuthUser } from '../../common/decorators/current-user.decorator';

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/markdown',
  'text/plain',
  'text/html',
]);

const progressKey = (documentId: string) => `doc:progress:${documentId}`;

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documents: Repository<DocumentEntity>,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaces: Repository<WorkspaceEntity>,
    private readonly storage: StorageService,
    private readonly ingestion: IngestionProducer,
    private readonly acl: AclService,
    private readonly redis: RedisService,
    private readonly alert: AclAlertService,
  ) {}

  async uploadInit(workspaceId: string, uploaderId: string, filename: string, fileSize: number, mimeType: string) {
    if (!ALLOWED_MIME.has(mimeType)) {
      throw new BizException(ErrorCode.PARAM_INVALID, `不支持的文件类型: ${mimeType}`, 400);
    }
    const { fileKey, uploadId, partUrls, partSize } = await this.storage.initMultipartUpload(filename, fileSize);
    const doc = await this.documents.save(
      this.documents.create({
        workspaceId,
        uploaderId,
        title: filename,
        fileKey,
        mimeType,
        fileSize,
        status: DocumentStatus.UPLOADED,
        meta: { uploadId, partCount: partUrls.length },
      }),
    );
    return { document_id: doc.id, upload_id: uploadId, part_urls: partUrls, part_size: partSize };
  }

  async uploadComplete(documentId: string, uploadId: string, partCount: number) {
    const doc = await this.mustGet(documentId);
    if (doc.meta?.uploadId !== uploadId) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'upload_id 不匹配', 400);
    }
    if (doc.status !== DocumentStatus.UPLOADED) {
      throw new BizException(ErrorCode.DOC_STATUS_INVALID, `当前状态 ${doc.status} 不可重复提交`, 400);
    }

    const { contentHash } = await this.storage.completeMultipartUpload(doc.fileKey, partCount);

    // 内容防重：同空间已有相同 sha256 的文档时拒绝（REJECTED/已删除允许重传）
    const dup = await this.findDuplicate(doc.workspaceId, contentHash, doc.id);
    if (dup) {
      await this.storage.remove(doc.fileKey);
      await this.documents.delete(doc.id);
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `内容与已有文档《${dup.title}》重复，无需重复上传`,
        409,
      );
    }

    doc.contentHash = contentHash;
    // 审核制：上传完成后进入待审核，由部门审核员通过后才入队解析
    await this.transition(doc, DocumentStatus.PENDING_REVIEW);
    return { document_id: doc.id, status: DocumentStatus.PENDING_REVIEW };
  }

  /** 同空间内容查重：返回首个相同 hash 的有效文档（排除 REJECTED/已删除/自身） */
  private async findDuplicate(workspaceId: string, contentHash: string, excludeId?: string) {
    return this.documents.findOne({
      where: {
        workspaceId,
        contentHash,
        deletedAt: IsNull(),
        status: Not(DocumentStatus.REJECTED),
        ...(excludeId ? { id: Not(excludeId) } : {}),
      },
      order: { createdAt: 'ASC' },
    });
  }

  /** 上传前预检：前端算好 sha256 先查重，命中则不必上传 */
  async checkDuplicate(workspaceId: string, contentHash: string) {
    if (!/^[0-9a-f]{64}$/.test(contentHash)) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'content_hash 格式不正确', 400);
    }
    const dup = await this.findDuplicate(workspaceId, contentHash);
    return { duplicate: !!dup, title: dup?.title ?? null };
  }

  /**
   * 文档审核：通过则入队解析，拒绝则标记 REJECTED + 理由。
   * 审核人：文档所在空间挂靠部门的审核员；未挂部门时 sysadmin 兜底。
   */
  async review(user: AuthUser, documentId: string, approve: boolean, reason?: string) {
    const doc = await this.mustGet(documentId);
    if (doc.status !== DocumentStatus.PENDING_REVIEW) {
      throw new BizException(ErrorCode.DOC_STATUS_INVALID, '该文档不在待审核状态', 400);
    }
    await this.assertReviewer(user, doc);

    doc.reviewedBy = user.userId;
    doc.reviewedAt = new Date();
    if (approve) {
      doc.reviewNote = null;
      await this.transition(doc, DocumentStatus.PARSING);
      await this.ingestion.enqueue({ documentId: doc.id });
    } else {
      doc.reviewNote = reason?.trim() || null;
      await this.transition(doc, DocumentStatus.REJECTED);
    }
    return { document_id: doc.id, status: doc.status };
  }

  /** 批量审核：逐条复用单条逻辑（权限/状态校验），单条失败不阻断其他 */
  async reviewBatch(user: AuthUser, ids: string[], approve: boolean, reason?: string) {
    const results: { document_id: string; ok: boolean; message?: string }[] = [];
    for (const id of ids) {
      try {
        await this.review(user, id, approve, reason);
        results.push({ document_id: id, ok: true });
      } catch (e) {
        results.push({ document_id: id, ok: false, message: (e as Error).message });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return { results, succeeded, failed: results.length - succeeded };
  }

  /** 待审核列表：我作为审核员的部门下的待审核文档；sysadmin 另含未挂部门的 */
  async pendingReviewList(user: AuthUser) {
    const departmentIds = await this.acl.adminDepartmentIds(user.userId);
    const wsRows = await this.workspaces.find();
    const depOf = new Map(wsRows.map((w) => [w.id, w.departmentId]));
    const inScope = wsRows
      .filter((w) =>
        w.departmentId
          ? departmentIds.includes(w.departmentId) || user.role === SystemRole.SYSADMIN
          : user.role === SystemRole.SYSADMIN,
      )
      .map((w) => w.id);
    if (inScope.length === 0) return { items: [] };
    const items = await this.documents.find({
      where: { workspaceId: In(inScope), status: DocumentStatus.PENDING_REVIEW, deletedAt: IsNull() },
      relations: { uploader: true, workspace: true },
      order: { createdAt: 'ASC' },
    });
    return {
      items: items.map((d) => ({
        id: d.id,
        title: d.title,
        mime_type: d.mimeType,
        file_size: d.fileSize,
        status: d.status,
        created_at: d.createdAt,
        workspace: { id: d.workspace.id, name: d.workspace.name, department_id: depOf.get(d.workspaceId) },
        uploader: { id: d.uploader.id, name: d.uploader.name, email: d.uploader.email },
      })),
    };
  }

  async list(workspaceId: string, page = 1, pageSize = 20) {
    const [items, total] = await this.documents.findAndCount({
      where: { workspaceId, deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      total,
      page,
      page_size: pageSize,
      items: items.map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        mime_type: d.mimeType,
        file_size: Number(d.fileSize),
        error_msg: d.errorMsg,
        review_note: d.reviewNote,
        created_at: d.createdAt,
      })),
    };
  }

  async detail(documentId: string) {
    const doc = await this.mustGet(documentId);
    return doc;
  }

  async downloadUrl(documentId: string) {
    const doc = await this.mustGet(documentId);
    // 可预览类型（PDF/文本）inline 打开，其余 attachment 下载
    const url = await this.storage.presignDownload(doc.fileKey, 3600, doc.title, doc.mimeType);
    return { url, previewable: StorageService.INLINE_MIME.has(doc.mimeType), title: doc.title };
  }

  async progress(documentId: string) {
    const doc = await this.mustGet(documentId);
    const progress = await this.redis.raw.hgetall(progressKey(documentId));
    return {
      status: doc.status,
      stage: progress.stage ?? null,
      percent: progress.percent ? Number(progress.percent) : null,
      error_msg: doc.errorMsg,
    };
  }

  async reindex(documentId: string, fromStage: 'parse' | 'chunk' | 'index' | 'graph' = 'index') {
    const doc = await this.mustGet(documentId);
    if (doc.status !== DocumentStatus.READY && doc.status !== DocumentStatus.FAILED) {
      throw new BizException(ErrorCode.DOC_STATUS_INVALID, '文档正在处理中，请稍后再试', 400);
    }
    await this.transition(doc, DocumentStatus.INDEXING);
    await this.ingestion.enqueue({ documentId: doc.id, fromStage });
    return { document_id: doc.id, status: DocumentStatus.INDEXING };
  }

  async remove(documentId: string) {
    const doc = await this.mustGet(documentId);
    doc.deletedAt = new Date();
    await this.documents.save(doc);
    // 异步清理由 worker 的清理任务完成（chunk/ES/Neo4j/MinIO）
    await this.ingestion.enqueue({ documentId: doc.id, fromStage: 'index' });
    return { deleted: true };
  }

  async transition(doc: DocumentEntity, status: DocumentStatus, errorMsg: string | null = null) {
    doc.status = status;
    doc.errorMsg = errorMsg;
    await this.documents.save(doc);
    await this.redis.raw.hset(progressKey(doc.id), { stage: status.toLowerCase() });
    await this.redis.raw.expire(progressKey(doc.id), 3600);
  }

  async setProgress(documentId: string, percent: number) {
    await this.redis.raw.hset(progressKey(documentId), { percent: String(percent) });
  }

  private async mustGet(documentId: string): Promise<DocumentEntity> {
    const doc = await this.documents.findOne({ where: { id: documentId } });
    if (!doc || doc.deletedAt) throw new BizException(ErrorCode.NOT_FOUND, '文档不存在', 404);
    return doc;
  }

  /** 校验当前用户对文档所在空间的最低角色 */
  async assertRole(userId: string, documentId: string, minRole: WorkspaceRole) {
    const doc = await this.mustGet(documentId);
    const role = await this.acl.getRole(userId, doc.workspaceId);
    const rank: Record<WorkspaceRole, number> = { viewer: 1, editor: 2, owner: 3 };
    if (!role || rank[role] < rank[minRole]) {
      await this.alert.trackDenied({
        userId,
        resource: 'document',
        detail: { document_id: documentId, role: role ?? null, required: minRole },
      });
      throw new BizException(ErrorCode.ACL_FORBIDDEN, '无权操作该文档', 403);
    }
    return doc;
  }

  /** 查看/下载权限：空间成员、文档所属部门的审核员（审核预览需要）、sysadmin */
  async assertViewable(user: AuthUser, documentId: string) {
    const doc = await this.mustGet(documentId);
    if (user.role === SystemRole.SYSADMIN) return doc;
    const role = await this.acl.getRole(user.userId, doc.workspaceId);
    if (role) return doc;
    if (await this.isDocReviewer(user.userId, doc)) return doc;
    await this.alert.trackDenied({
      userId: user.userId,
      resource: 'document',
      detail: { document_id: documentId, role: null, required: 'viewer|reviewer' },
    });
    throw new BizException(ErrorCode.ACL_FORBIDDEN, '无权访问该文档', 403);
  }

  /** 审核权限：文档所属部门的审核员；sysadmin 兜底（含未挂部门的情况） */
  private async assertReviewer(user: AuthUser, doc: DocumentEntity) {
    if (user.role === SystemRole.SYSADMIN) return;
    if (await this.isDocReviewer(user.userId, doc)) return;
    throw new BizException(ErrorCode.ACL_FORBIDDEN, '您不是该文档所属部门的审核员', 403);
  }

  private async isDocReviewer(userId: string, doc: DocumentEntity) {
    const ws = await this.workspaces.findOne({ where: { id: doc.workspaceId } });
    if (!ws?.departmentId) return false;
    return this.acl.isDepartmentAdmin(userId, ws.departmentId);
  }
}
