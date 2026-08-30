import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentStatus, ErrorCode, WorkspaceRole } from '@ekh/shared';
import { DocumentEntity } from '../../database/entities/document.entity';
import { BizException } from '../../common/filters/http-exception.filter';
import { RedisService } from '../../redis/redis.service';
import { AclService } from '../workspaces/acl.service';
import { AclAlertService } from '../audit/acl-alert.service';
import { IngestionProducer } from '../ingestion/ingestion.producer';
import { StorageService } from './storage.service';

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

    await this.storage.completeMultipartUpload(doc.fileKey, partCount);
    await this.transition(doc, DocumentStatus.PARSING);
    await this.ingestion.enqueue({ documentId: doc.id });
    return { document_id: doc.id, status: DocumentStatus.PARSING };
  }

  async list(workspaceId: string, page = 1, pageSize = 20) {
    const [items, total] = await this.documents.findAndCount({
      where: { workspaceId, deletedAt: undefined },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return { total, page, page_size: pageSize, items };
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
}
