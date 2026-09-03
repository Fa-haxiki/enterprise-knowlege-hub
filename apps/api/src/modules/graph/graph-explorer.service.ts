import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { DocumentStatus, ErrorCode } from '@ekh/shared';
import { DocumentEntity } from '../../database/entities/document.entity';
import { BizException } from '../../common/filters/http-exception.filter';
import { IngestionProducer } from '../ingestion/ingestion.producer';
import { GraphService, type EntityDetail } from './graph.service';

export interface EntityMentionDoc {
  document_id: string;
  title: string;
  chunks: { chunk_id: string; snippet: string; page?: number; heading_path: string[] }[];
}

export interface EntityDetailResponse extends Omit<EntityDetail, 'mentions'> {
  documents: EntityMentionDoc[];
}

const SNIPPET_CHARS = 160;

/**
 * 知识图谱页面的编排层：Neo4j 子图 + PG 文档元数据拼装，以及空间级 / 全量重建。
 * Neo4j 只存 chunk_id/document_id，标题、片段、页码都要回 PG 取。
 */
@Injectable()
export class GraphExplorerService {
  private readonly logger = new Logger(GraphExplorerService.name);

  constructor(
    private readonly graph: GraphService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(DocumentEntity)
    private readonly documents: Repository<DocumentEntity>,
    private readonly ingestion: IngestionProducer,
  ) {}

  async entityDetail(workspaceId: string, entityId: string): Promise<EntityDetailResponse> {
    const detail = await this.graph.entityDetail(workspaceId, entityId);
    if (!detail) throw new BizException(ErrorCode.NOT_FOUND, '实体不存在', 404);
    const { mentions, ...rest } = detail;
    return { ...rest, documents: await this.loadMentionDocs(mentions.map((m) => m.chunkId)) };
  }

  /** chunk_id → 所属文档标题 + 片段摘要，按文档分组（已删文档过滤） */
  private async loadMentionDocs(chunkIds: string[]): Promise<EntityMentionDoc[]> {
    if (chunkIds.length === 0) return [];
    const rows = (await this.dataSource.query(
      `SELECT c.id, c.document_id, c.content, c.refs, c.heading_path, c.chunk_index, d.title
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE c.id = ANY($1) AND d.deleted_at IS NULL
       ORDER BY d.title, c.chunk_index`,
      [chunkIds],
    )) as {
      id: string;
      document_id: string;
      content: string;
      refs: { page?: number } | null;
      heading_path: string[] | null;
      title: string;
    }[];
    const byDoc = new Map<string, EntityMentionDoc>();
    for (const r of rows) {
      const doc = byDoc.get(r.document_id) ?? { document_id: r.document_id, title: r.title, chunks: [] };
      doc.chunks.push({
        chunk_id: r.id,
        snippet: r.content.length > SNIPPET_CHARS ? `${r.content.slice(0, SNIPPET_CHARS)}…` : r.content,
        page: r.refs?.page,
        heading_path: r.heading_path ?? [],
      });
      byDoc.set(r.document_id, doc);
    }
    return [...byDoc.values()];
  }

  /** 空间级重建：清空该空间图数据，全部 READY 文档重跑 graph 阶段 */
  async rebuildWorkspace(workspaceId: string): Promise<{ documents: number }> {
    await this.graph.deleteByWorkspace(workspaceId);
    const docs = await this.documents.find({
      where: { workspaceId, status: DocumentStatus.READY, deletedAt: IsNull() },
      select: ['id'],
    });
    return { documents: await this.enqueueGraphRebuild(docs.map((d) => d.id)) };
  }

  /** 全量重建（sysadmin）：清空 Neo4j 并重建 schema，所有 READY 文档重跑 graph 阶段 */
  async rebuildAll(): Promise<{ documents: number; deletedNodes: number }> {
    const { deletedNodes } = await this.graph.resetAll();
    const docs = await this.documents.find({
      where: { status: DocumentStatus.READY, deletedAt: IsNull() },
      select: ['id'],
    });
    const documents = await this.enqueueGraphRebuild(docs.map((d) => d.id));
    this.logger.warn(`graph rebuild-all: ${deletedNodes} nodes cleared, ${documents} documents enqueued`);
    return { documents, deletedNodes };
  }

  /** 状态置 GRAPHING 让文档页可见「处理中」，再逐个入队；已有在途任务的文档跳过 */
  private async enqueueGraphRebuild(documentIds: string[]): Promise<number> {
    if (documentIds.length === 0) return 0;
    let queued = 0;
    for (const id of documentIds) {
      const { queued: ok } = await this.ingestion.enqueue({ documentId: id, fromStage: 'graph' });
      if (ok) queued++;
    }
    if (queued > 0) {
      await this.documents.update(
        { id: In(documentIds), status: DocumentStatus.READY },
        { status: DocumentStatus.GRAPHING, errorMsg: null },
      );
    }
    return queued;
  }
}
