import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Job } from 'bullmq';
import { DocumentStatus, IngestionStage, JobStatus } from '@ekh/shared';
import { DocumentEntity } from '@ekh/api/database/entities/document.entity';
import { DocumentChunkEntity } from '@ekh/api/database/entities/document-chunk.entity';
import { IngestionJobEntity } from '@ekh/api/database/entities/ingestion-job.entity';
import { StorageService } from '@ekh/api/modules/documents/storage.service';
import { EmbeddingService } from '@ekh/api/modules/llm/embedding.service';
import { EsService } from '@ekh/api/modules/retrieval/es.service';
import { GraphService } from '@ekh/api/modules/graph/graph.service';
import { RedisService } from '@ekh/api/redis/redis.service';
import { MineruClient, type MineruResult } from '../pipelines/mineru.client';
import { Chunker, type ChunkDraft } from '../pipelines/chunker';
import { EntityExtractor } from '../pipelines/entity-extractor';

interface IngestionJobData {
  documentId: string;
  fromStage?: 'parse' | 'chunk' | 'index' | 'graph';
}

const progressKey = (id: string) => `doc:progress:${id}`;

/** 入库管线：MinerU 解析 → 语义分块 → Embedding + 双写索引 → 实体抽取建图 */
@Processor('ingestion', { concurrency: 2 })
export class IngestionProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestionProcessor.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documents: Repository<DocumentEntity>,
    @InjectRepository(DocumentChunkEntity)
    private readonly chunks: Repository<DocumentChunkEntity>,
    @InjectRepository(IngestionJobEntity)
    private readonly jobs: Repository<IngestionJobEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly mineru: MineruClient,
    private readonly chunker: Chunker,
    private readonly extractor: EntityExtractor,
    private readonly embedding: EmbeddingService,
    private readonly es: EsService,
    private readonly graphDb: GraphService,
    private readonly redis: RedisService,
  ) {
    super();
  }

  async process(job: Job<IngestionJobData>): Promise<void> {
    const { documentId } = job.data;
    const doc = await this.documents.findOne({ where: { id: documentId } });
    if (!doc) {
      this.logger.warn(`document ${documentId} not found, skip`);
      return;
    }

    // 软删除文档：清理索引与图数据
    if (doc.deletedAt) {
      await this.purge(doc);
      return;
    }

    try {
      // 1. MinerU 解析
      await this.transition(doc, DocumentStatus.PARSING, 5);
      const file = await this.storage.getObjectBuffer(doc.fileKey);
      const parsed = await this.mineru.parse(file, doc.title);
      await this.trackJob(documentId, IngestionStage.PARSE, JobStatus.DONE);

      // 2. 语义分块
      await this.transition(doc, DocumentStatus.CHUNKING, 30);
      const drafts = this.chunker.chunk(parsed.blocks);
      await this.trackJob(documentId, IngestionStage.CHUNK, JobStatus.DONE);
      this.logger.log(`document ${documentId}: ${drafts.length} chunks`);

      // 3. Embedding + PGVector/ES 双写
      await this.transition(doc, DocumentStatus.INDEXING, 50);
      await this.indexChunks(doc, drafts, parsed);
      await this.trackJob(documentId, IngestionStage.INDEX, JobStatus.DONE);

      // 4. 实体抽取 + Neo4j 建图（失败不阻断 READY）
      await this.transition(doc, DocumentStatus.GRAPHING, 85);
      try {
        await this.buildGraph(doc, drafts);
        await this.trackJob(documentId, IngestionStage.GRAPH, JobStatus.DONE);
      } catch (e) {
        this.logger.warn(`graph stage degraded: ${(e as Error).message}`);
        await this.trackJob(documentId, IngestionStage.GRAPH, JobStatus.FAILED, (e as Error).message);
      }

      await this.transition(doc, DocumentStatus.READY, 100);
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.error(`ingestion failed for ${documentId}: ${msg}`, (e as Error).stack);
      await this.transition(doc, DocumentStatus.FAILED, null, msg);
      throw e; // 交给 BullMQ 重试（attempts=3 指数退避）
    }
  }

  /** Embedding + 双写：批量向量化，PG 事务写入后逐条写 ES */
  private async indexChunks(doc: DocumentEntity, drafts: ChunkDraft[], parsed: MineruResult) {
    // 重建场景：先清旧数据
    await this.chunks.delete({ documentId: doc.id });
    await this.es.deleteByDocument(doc.id);

    const texts = drafts.map((d) => this.chunker.enrichForEmbedding(doc.title, d));
    const vectors = await this.embedding.embed(texts);

    await this.dataSource.transaction(async (em) => {
      for (let i = 0; i < drafts.length; i++) {
        await em.save(
          em.create(DocumentChunkEntity, {
            documentId: doc.id,
            workspaceId: doc.workspaceId,
            chunkIndex: i,
            content: drafts[i].content,
            headingPath: drafts[i].headingPath,
            refs: drafts[i].refs,
            embedding: `[${vectors[i].join(',')}]`,
          }),
        );
      }
    });

    const saved = await this.chunks.find({ where: { documentId: doc.id }, order: { chunkIndex: 'ASC' } });
    for (const chunk of saved) {
      await this.es.indexChunk({
        chunk_id: chunk.id,
        document_id: doc.id,
        workspace_id: doc.workspaceId,
        title: doc.title,
        content: chunk.content,
        heading_path: chunk.headingPath,
      });
    }
    await this.es.raw.indices.refresh({ index: this.es.indexName }).catch(() => undefined);

    await this.documents.update(doc.id, {
      meta: { ...doc.meta, pages: parsed.meta.pages, parser: parsed.meta.parser_version },
    });
  }

  /** 实体抽取 + Neo4j 写入（按 chunk 批处理） */
  private async buildGraph(doc: DocumentEntity, drafts: ChunkDraft[]) {
    const saved = await this.chunks.find({ where: { documentId: doc.id }, order: { chunkIndex: 'ASC' } });
    for (let i = 0; i < drafts.length; i++) {
      const result = await this.extractor.extract(drafts[i].content);
      if (result.entities.length === 0 && result.relations.length === 0) continue;
      await this.graphDb.upsertGraph({
        chunkId: saved[i].id,
        documentId: doc.id,
        workspaceId: doc.workspaceId,
        entities: result.entities,
        relations: result.relations,
      });
    }
  }

  /** 软删除清理：chunk / ES / Neo4j / MinIO */
  private async purge(doc: DocumentEntity) {
    await this.chunks.delete({ documentId: doc.id });
    await this.es.deleteByDocument(doc.id);
    await this.graphDb.deleteByDocument(doc.id).catch(() => undefined);
    await this.storage.remove(doc.fileKey);
    this.logger.log(`document ${doc.id} purged`);
  }

  private async transition(doc: DocumentEntity, status: DocumentStatus, percent: number | null, errorMsg: string | null = null) {
    doc.status = status;
    doc.errorMsg = errorMsg;
    await this.documents.save(doc);
    const fields: Record<string, string> = { stage: status.toLowerCase() };
    if (percent !== null) fields.percent = String(percent);
    await this.redis.raw.hset(progressKey(doc.id), fields);
    await this.redis.raw.expire(progressKey(doc.id), 3600);
  }

  private async trackJob(documentId: string, stage: IngestionStage, status: JobStatus, errorMsg?: string) {
    const existing = await this.jobs.findOne({ where: { documentId, stage } });
    if (existing) {
      await this.jobs.update(existing.id, { status, errorMsg: errorMsg ?? null });
    } else {
      await this.jobs.save(this.jobs.create({ documentId, stage, status, errorMsg: errorMsg ?? null }));
    }
  }
}
