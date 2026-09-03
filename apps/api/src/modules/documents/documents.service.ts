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

  /** 待审核列表（分页）：我作为审核员的部门下的待审核文档；sysadmin 另含未挂部门的 */
  async pendingReviewList(user: AuthUser, page = 1, pageSize = 10) {
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
    if (inScope.length === 0) return { items: [], total: 0, page, page_size: pageSize };
    const [rows, total] = await this.documents.findAndCount({
      where: { workspaceId: In(inScope), status: DocumentStatus.PENDING_REVIEW, deletedAt: IsNull() },
      relations: { uploader: true, workspace: true },
      order: { createdAt: 'ASC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: rows.map((d) => ({
        id: d.id,
        title: d.title,
        mime_type: d.mimeType,
        file_size: d.fileSize,
        status: d.status,
        created_at: d.createdAt,
        workspace: { id: d.workspace.id, name: d.workspace.name, department_id: depOf.get(d.workspaceId) },
        uploader: { id: d.uploader.id, name: d.uploader.name, email: d.uploader.email },
      })),
      total,
      page,
      page_size: pageSize,
    };
  }

  /** 文档类型筛选 → mimeType 映射（上传时由浏览器 file.type 落库） */
  private static readonly TYPE_MIME: Record<string, string[]> = {
    pdf: ['application/pdf'],
    word: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'],
    excel: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'],
    ppt: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'],
    md: ['text/markdown'],
    txt: ['text/plain'],
    html: ['text/html'],
  };

  /** 处理中状态集合：筛选「处理中」时展开 */
  private static readonly PROCESSING_STATUS = ['UPLOADED', 'PARSING', 'CHUNKING', 'INDEXING', 'GRAPHING'];

  async list(
    workspaceId: string,
    page = 1,
    pageSize = 20,
    filters?: { keyword?: string; status?: string; type?: string; dateFrom?: string; dateTo?: string },
  ) {
    const qb = this.documents
      .createQueryBuilder('d')
      .leftJoin('d.uploader', 'u')
      .addSelect(['u.id', 'u.name'])
      .where('d.workspace_id = :workspaceId', { workspaceId })
      .andWhere('d.deleted_at IS NULL')
      // 排序必须用实体属性路径（d.createdAt）：join + 分页时 TypeORM 走
      // createOrderByCombinedWithSelectExpression，按属性名解析元数据，列名会报 databaseName undefined
      .orderBy('d.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    if (filters?.keyword) {
      qb.andWhere('d.title ILIKE :kw', { kw: `%${filters.keyword}%` });
    }
    if (filters?.status) {
      if (filters.status === 'PROCESSING') {
        qb.andWhere('d.status IN (:...sts)', { sts: DocumentsService.PROCESSING_STATUS });
      } else {
        qb.andWhere('d.status = :st', { st: filters.status });
      }
    }
    if (filters?.type && DocumentsService.TYPE_MIME[filters.type]) {
      qb.andWhere('d.mime_type IN (:...mimes)', { mimes: DocumentsService.TYPE_MIME[filters.type] });
    }
    if (filters?.dateFrom) {
      qb.andWhere('d.created_at >= :df', { df: filters.dateFrom });
    }
    if (filters?.dateTo) {
      // 结束日期含当天：取次日零点前
      const end = new Date(filters.dateTo);
      end.setDate(end.getDate() + 1);
      qb.andWhere('d.created_at < :dt', { dt: end.toISOString() });
    }
    const [items, total] = await qb.getManyAndCount();
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
        uploader: d.uploader ? { id: d.uploader.id, name: d.uploader.name } : null,
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

  /**
   * 批量进度：一次请求返回多个文档的处理状态，避免列表页对每个处理中文档单独轮询触发限流。
   * 权限：sysadmin 全量可见；否则按 workspace 分组校验角色，无权的文档跳过（不返回）。
   */
  async batchProgress(user: AuthUser, ids: string[]) {
    const unique = [...new Set(ids)].slice(0, 200); // 上限保护，防止超大 body
    if (unique.length === 0) return { items: [] };
    const docs = await this.documents.find({ where: { id: In(unique), deletedAt: IsNull() } });

    // 按 workspace 分组，逐个 workspace 查一次角色（acl 带缓存），避免每文档一次 ACL 查询
    const roleByWs = new Map<string, WorkspaceRole | null>();
    const allowed: DocumentEntity[] = [];
    for (const doc of docs) {
      if (user.role === SystemRole.SYSADMIN) {
        allowed.push(doc);
        continue;
      }
      if (!roleByWs.has(doc.workspaceId)) {
        roleByWs.set(doc.workspaceId, await this.acl.getRole(user.userId, doc.workspaceId));
      }
      if (roleByWs.get(doc.workspaceId)) allowed.push(doc);
    }

    // pipeline 批量取进度 hash，一次 Redis 往返
    const pipe = this.redis.raw.pipeline();
    for (const doc of allowed) pipe.hgetall(progressKey(doc.id));
    const rows = (await pipe.exec()) ?? [];

    const items = allowed.map((doc, i) => {
      const [, progress] = (rows[i] ?? [null, {}]) as [Error | null, Record<string, string>];
      return {
        id: doc.id,
        status: doc.status,
        stage: progress?.stage ?? null,
        percent: progress?.percent ? Number(progress.percent) : null,
        error_msg: doc.errorMsg,
      };
    });
    return { items };
  }

  async reindex(documentId: string, fromStage: 'parse' | 'chunk' | 'index' | 'graph' = 'index') {
    const doc = await this.mustGet(documentId);
    if (doc.status !== DocumentStatus.READY && doc.status !== DocumentStatus.FAILED) {
      throw new BizException(ErrorCode.DOC_STATUS_INVALID, '文档正在处理中，请稍后再试', 400);
    }
    // 仅重建图谱不会重跑索引，状态直接进 GRAPHING 让文档页显示准确
    const status = fromStage === 'graph' ? DocumentStatus.GRAPHING : DocumentStatus.INDEXING;
    await this.transition(doc, status);
    await this.ingestion.enqueue({ documentId: doc.id, fromStage });
    return { document_id: doc.id, status };
  }

  async remove(documentId: string) {
    const doc = await this.mustGet(documentId);
    doc.deletedAt = new Date();
    await this.documents.save(doc);
    // 先取消尚未开始的在途入库任务，再入队清理；进行中的任务会在下一阶段写前自检 deletedAt 中断
    await this.ingestion.removePending(doc.id);
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
