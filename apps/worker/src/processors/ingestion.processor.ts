import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { LangfuseService, type TraceHandle } from '@ekh/api/modules/observability/langfuse.service';
import { MineruClient, type MineruResult } from '../pipelines/mineru.client';
import { TextParser } from '../pipelines/text-parser';
import { Chunker, type ChunkDraft } from '../pipelines/chunker';
import { EntityExtractor, type ExtractionResult } from '../pipelines/entity-extractor';

/** BullMQ 任务载荷。fromStage 仅用于「从某阶段重跑」，缺省则走全量管线。 */
interface IngestionJobData {
  documentId: string;
  fromStage?: 'parse' | 'chunk' | 'index' | 'graph';
}

/** 前端轮询入库进度的 Redis Hash 键；TTL 1h，见 transition()。 */
const progressKey = (id: string) => `doc:progress:${id}`;

/** 实体抽取并发度：LLM 调用是 graph 阶段瓶颈，4 路并发将 8 chunks 从 ~3.5min 压到 ~1min */
const GRAPH_EXTRACT_CONCURRENCY = 4;

/**
 * 文档入库消费者（BullMQ queue=`ingestion`，同时处理 2 份文档）。
 *
 * 全量管线（process 主路径）：
 *   1. parse   MinerU 解析 PDF/Office → 结构化 blocks
 *   2. chunk   按标题层级 + 段落边界切成语义块
 *   3. index   Embedding 后双写 PGVector（语义检索）+ ES（关键词检索）
 *   4. graph   LLM 抽实体/关系写入 Neo4j；失败只降级，不阻断 READY
 *
 * 旁路：
 *   - 文档已软删除 → purge 清 chunk / ES / Neo4j / MinIO
 *   - fromStage=graph → 跳过解析/分块/索引，用已有分片重跑图谱
 *
 * 进度：PG documents.status 给权威状态，Redis Hash 给前端实时百分比。
 * 观测：每阶段写入 ingestion_jobs；Langfuse trace 覆盖整条管线。
 */
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
    private readonly textParser: TextParser,
    private readonly chunker: Chunker,
    private readonly extractor: EntityExtractor,
    private readonly embedding: EmbeddingService,
    private readonly es: EsService,
    private readonly graphDb: GraphService,
    private readonly redis: RedisService,
    private readonly langfuse: LangfuseService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  /**
   * 领取一条入库任务。
   * `token` 是 BullMQ 锁令牌：MinerU / Batch Embedding 会轮询数分钟，
   * 必须定期 extendLock，否则 worker 会被标 stalled、任务被重投导致重复入库。
   */
  async process(job: Job<IngestionJobData>, token?: string): Promise<void> {
    const { documentId, fromStage } = job.data;
    const doc = await this.documents.findOne({ where: { id: documentId } });
    if (!doc) {
      this.logger.warn(`document ${documentId} not found, skip`);
      return;
    }

    // 软删除文档：清理索引与图数据后退出，不再走解析
    if (doc.deletedAt) {
      await this.purge(doc); // 清洗
      return;
    }

    // 仅重建图谱：跳过解析/分块/索引，基于已有分片重跑实体抽取
    if (fromStage === 'graph') {
      await this.rebuildGraphOnly(doc);
      return;
    }

    const trace = this.langfuse.createTrace('document_ingestion', {
      documentId: doc.id,
      title: doc.title,
      workspaceId: doc.workspaceId,
    });

    try {
      // 1. 解析：md/txt/html 纯文本类走本地解析（MinerU 线上仅支持 PDF/Office），其余走 MinerU 线上解析
      await this.transition(doc, DocumentStatus.PARSING, 5);
      const parseSpan = this.langfuse.createSpan(trace, 'parse', { title: doc.title });
      const file = await this.storage.getObjectBuffer(doc.fileKey);
      const parsed = TextParser.isTextFile(doc.title)
        ? this.textParser.parse(file, doc.title)
        : await this.mineru.parse(file, doc.title, () => {
            if (token) void job.extendLock(token, 60_000).catch(() => undefined);
          });
      this.langfuse.endSpan(parseSpan, { pages: parsed.meta.pages, blocks: parsed.blocks.length });
      await this.trackJob(documentId, IngestionStage.PARSE, JobStatus.DONE);
      await this.assertNotDeleted(documentId);

      // 2. 语义分块（纯 CPU，按标题路径聚合 + 超长二次切分）
      await this.transition(doc, DocumentStatus.CHUNKING, 30);
      const chunkSpan = this.langfuse.createSpan(trace, 'chunk', { blocks: parsed.blocks.length });
      const drafts = this.chunker.chunk(parsed.blocks);
      this.langfuse.endSpan(chunkSpan, { chunks: drafts.length });
      await this.trackJob(documentId, IngestionStage.CHUNK, JobStatus.DONE);
      this.logger.log(`document ${documentId}: ${drafts.length} chunks`);

      // 3. Embedding（小批量同步 / 大批量 Batch API）+ PGVector/ES 双写
      await this.transition(doc, DocumentStatus.INDEXING, 50);
      await this.assertNotDeleted(documentId);
      await this.indexChunks(doc, drafts, parsed, job, token, trace);
      await this.trackJob(documentId, IngestionStage.INDEX, JobStatus.DONE);

      // 4. 实体抽取 + Neo4j 建图（失败不阻断 READY：检索仍可用，图谱降级）
      await this.transition(doc, DocumentStatus.GRAPHING, 85);
      await this.assertNotDeleted(documentId);
      try {
        await this.buildGraph(doc, drafts, trace);
        await this.trackJob(documentId, IngestionStage.GRAPH, JobStatus.DONE);
      } catch (e) {
        this.logger.warn(`graph stage degraded: ${(e as Error).message}`);
        await this.trackJob(documentId, IngestionStage.GRAPH, JobStatus.FAILED, (e as Error).message);
      }

      await this.assertNotDeleted(documentId);
      await this.transition(doc, DocumentStatus.READY, 100);
      trace?.update({ output: 'ready', metadata: { chunks: await this.chunks.countBy({ documentId: doc.id }) } });
    } catch (e) {
      const msg = (e as Error).message;
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      this.logger.error(
        `ingestion failed for ${documentId}: ${msg} cause=${cause?.code ?? ''} ${cause?.message ?? ''}`,
        (e as Error).stack,
      );
      trace?.update({ output: 'failed', metadata: { error: msg } });
      await this.transition(doc, DocumentStatus.FAILED, null, msg);
      throw e; // 交给 BullMQ 重试（attempts=3 指数退避）；indexChunks 先清后写，重试幂等
    }
  }

  /**
   * Embedding + 双写（整段包一层 Langfuse `index` span，失败也结束）：
   *   1. 先删旧 chunk / ES 文档（重建与重试都幂等）
   *   2. 按数量选同步或 Batch 通道做向量化（generation 记 token）
   *   3. PG 事务写入（embedding 以 pgvector 文本格式 `[1,2,...]` 入库）
   *   4. 再按落库后的 chunk.id 逐条写 ES，最后 refresh 让检索立即可用
   */
  private async indexChunks(
    doc: DocumentEntity,
    drafts: ChunkDraft[],
    parsed: MineruResult,
    job: Job<IngestionJobData>,
    token?: string,
    trace?: TraceHandle | null,
  ) {
    const span = this.langfuse.createSpan(trace ?? null, 'index', { chunks: drafts.length });
    try {
      // 重建 / 重试场景：先清旧数据，再全量写入
      await this.chunks.delete({ documentId: doc.id });
      await this.es.deleteByDocument(doc.id);

      const texts = drafts.map((d) => this.chunker.enrichForEmbedding(doc.title, d));
      // 按 chunk 数选通道：小批量走同步接口（秒级），大批量走 Batch API（半价异步）
      const syncThreshold = this.config.get<number>('embedding.syncThreshold') ?? 20;
      const channel =
        texts.length === 0 ? 'skip' : texts.length <= syncThreshold ? 'sync' : 'batch';
      const vectors =
        texts.length === 0
          ? ([] as number[][])
          : channel === 'sync'
            ? await this.embedViaSync(texts, trace)
            : await this.embedViaBatch(texts, job, token, trace);

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

      // 必须先落 PG 再写 ES：ES 文档主键用的是 PG 生成的 chunk.id
      const docType = doc.title.includes('.')
        ? doc.title.split('.').pop()!.toLowerCase()
        : 'unknown';
      const saved = await this.chunks.find({ where: { documentId: doc.id }, order: { chunkIndex: 'ASC' } });
      for (const chunk of saved) {
        await this.es.indexChunk({
          chunk_id: chunk.id,
          document_id: doc.id,
          workspace_id: doc.workspaceId,
          doc_type: docType,
          title: doc.title,
          content: chunk.content,
          heading_path: chunk.headingPath,
        });
      }
      await this.es.raw.indices.refresh({ index: this.es.indexName }).catch(() => undefined);

      await this.documents.update(doc.id, {
        meta: { ...doc.meta, pages: parsed.meta.pages, parser: parsed.meta.parser_version },
      });
      this.langfuse.endSpan(span, { chunks: saved.length, channel });
    } catch (e) {
      this.langfuse.endSpan(span, {}, e as Error);
      throw e;
    }
  }

  /** 同步接口向量化：小批量场景秒级返回，免去 Batch 排队开销 */
  private async embedViaSync(texts: string[], trace?: TraceHandle | null): Promise<number[][]> {
    const generation = this.langfuse.createGeneration(trace ?? null, {
      name: 'embedding_sync',
      model: this.config.get<string>('embedding.model') ?? 'unknown',
      input: { texts: texts.length },
    });
    try {
      const { vectors, usage } = await this.embedding.embedWithUsage(texts);
      this.langfuse.endGeneration(generation, {
        output: `sync embed ${texts.length} texts`,
        usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: 0 },
      });
      this.logger.log(`sync embedding done: ${texts.length} texts, ${usage.prompt_tokens} tokens`);
      return vectors;
    } catch (e) {
      this.langfuse.endGeneration(generation, {
        output: `failed: ${(e as Error).message}`,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
      throw e;
    }
  }

  /**
   * 百炼 Batch API 向量化：提交后每 15s 轮询，期间续 BullMQ 锁防 stalled；
   * 20 分钟未完成抛错走 BullMQ 重试（重建场景幂等：先清后写）
   */
  private async embedViaBatch(
    texts: string[],
    job: Job<IngestionJobData>,
    token?: string,
    trace?: TraceHandle | null,
  ): Promise<number[][]> {
    const generation = this.langfuse.createGeneration(trace ?? null, {
      name: 'embedding_batch',
      model: this.config.get<string>('embedding.model') ?? 'unknown',
      input: { texts: texts.length },
    });
    const batchId = await this.embedding.submitEmbedBatch(texts);
    this.logger.log(`embedding batch ${batchId} submitted (${texts.length} texts), polling...`);
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 15_000));
      if (token) await job.extendLock(token, 60_000).catch(() => undefined);
      const info = await this.embedding.getBatch(batchId);
      if (info.status === 'completed' && info.outputFileId) {
        const { vectors, usage } = await this.embedding.downloadBatchVectors(info.outputFileId, texts.length);
        this.langfuse.endGeneration(generation, {
          output: `batch ${batchId} completed`,
          usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: 0 },
        });
        return vectors;
      }
      if (info.status === 'failed' || info.status === 'expired' || info.status === 'cancelled') {
        const err = new Error(`embedding batch ${batchId} ${info.status}: ${info.error ?? 'unknown'}`);
        this.langfuse.endGeneration(generation, { output: '', usage: { prompt_tokens: 0, completion_tokens: 0 } });
        throw err;
      }
      if (Date.now() > deadline) {
        throw new Error(`embedding batch ${batchId} timeout after 20min (status=${info.status})`);
      }
    }
  }

  /**
   * 实体抽取 + Neo4j 写入：
   *   - 用共享 cursor 拉起 N 个 worker，4 路并发打 LLM（单 chunk 失败只跳过）
   *   - 全部抽完后再按 chunk 顺序写图，避免并发 upsert 打乱关系
   *   - LLM 用量汇总成一条 Langfuse generation（失败也落埋点）
   */
  private async buildGraph(doc: DocumentEntity, drafts: ChunkDraft[], trace?: TraceHandle | null) {
    const span = this.langfuse.createSpan(trace ?? null, 'graph', { chunks: drafts.length });
    const generation = this.langfuse.createGeneration(trace ?? null, {
      name: 'entity_extract',
      model: this.config.get<string>('llm.model') ?? 'unknown',
      input: { chunks: drafts.length },
    });
    const saved = await this.chunks.find({ where: { documentId: doc.id }, order: { chunkIndex: 'ASC' } });

    // 简易 worker pool：多个协程抢同一个 cursor，结果按原下标回填
    const results: (ExtractionResult | null)[] = new Array(drafts.length).fill(null);
    let cursor = 0;
    let failedChunks = 0;
    const runWorker = async () => {
      while (cursor < drafts.length) {
        const i = cursor++;
        try {
          results[i] = await this.extractor.extract(drafts[i].content);
        } catch (e) {
          failedChunks++;
          this.logger.warn(`chunk ${i} entity extract failed (skipped): ${(e as Error).message}`);
        }
      }
    };

    let entities = 0;
    let relations = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    try {
      await Promise.all(Array.from({ length: GRAPH_EXTRACT_CONCURRENCY }, () => runWorker()));

      for (let i = 0; i < drafts.length; i++) {
        const result = results[i];
        if (!result) continue;
        promptTokens += result.usage?.prompt_tokens ?? 0;
        completionTokens += result.usage?.completion_tokens ?? 0;
        if (result.entities.length === 0 && result.relations.length === 0) continue;
        entities += result.entities.length;
        relations += result.relations.length;
        await this.graphDb.upsertGraph({
          chunkId: saved[i].id,
          documentId: doc.id,
          workspaceId: doc.workspaceId,
          entities: result.entities,
          relations: result.relations,
        });
      }
      this.langfuse.endGeneration(generation, {
        output: `entities=${entities} relations=${relations} failedChunks=${failedChunks}`,
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      });
      this.langfuse.endSpan(span, { entities, relations, failedChunks });
    } catch (e) {
      this.langfuse.endGeneration(generation, {
        output: `failed: ${(e as Error).message}`,
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
      });
      this.langfuse.endSpan(span, { entities, relations, failedChunks }, e as Error);
      throw e;
    }
  }

  /** 仅重建图谱：用已落库的分片重跑实体抽取（不清空索引，文档最终仍标 READY） */
  private async rebuildGraphOnly(doc: DocumentEntity) {
    await this.transition(doc, DocumentStatus.GRAPHING, 85);
    try {
      const saved = await this.chunks.find({ where: { documentId: doc.id }, order: { chunkIndex: 'ASC' } });
      for (const chunk of saved) {
        const result = await this.extractor.extract(chunk.content);
        if (result.entities.length === 0 && result.relations.length === 0) continue;
        await this.graphDb.upsertGraph({
          chunkId: chunk.id,
          documentId: doc.id,
          workspaceId: doc.workspaceId,
          entities: result.entities,
          relations: result.relations,
        });
      }
      await this.trackJob(doc.id, IngestionStage.GRAPH, JobStatus.DONE);
      this.logger.log(`document ${doc.id} graph rebuilt: ${saved.length} chunks`);
    } catch (e) {
      this.logger.warn(`graph rebuild degraded: ${(e as Error).message}`);
      await this.trackJob(doc.id, IngestionStage.GRAPH, JobStatus.FAILED, (e as Error).message);
    }
    await this.transition(doc, DocumentStatus.READY, 100);
  }

  /** 阶段写前校验：文档在处理中被软删则抛错中断，由 purge 任务负责清理，避免已删文档被写回索引 */
  private async assertNotDeleted(documentId: string) {
    const current = await this.documents.findOne({
      where: { id: documentId },
      select: ['id', 'deletedAt'],
    });
    if (!current || current.deletedAt) {
      throw new Error(`document ${documentId} deleted during ingestion, abort`);
    }
  }

  /** 软删除清理：chunk / ES / Neo4j / MinIO 原文件一并去掉 */
  private async purge(doc: DocumentEntity) {
    await this.chunks.delete({ documentId: doc.id });
    await this.es.deleteByDocument(doc.id);
    await this.graphDb.deleteByDocument(doc.id).catch(() => undefined);
    await this.storage.remove(doc.fileKey);
    this.logger.log(`document ${doc.id} purged`);
  }

  /**
   * 推进文档状态：写 PG（权威）+ Redis Hash（前端进度条）。
   * percent=null 表示失败，不更新百分比，只改 stage。
   */
  private async transition(doc: DocumentEntity, status: DocumentStatus, percent: number | null, errorMsg: string | null = null) {
    doc.status = status;
    doc.errorMsg = errorMsg;
    await this.documents.save(doc);
    const fields: Record<string, string> = { stage: status.toLowerCase() };
    if (percent !== null) fields.percent = String(percent);
    await this.redis.raw.hset(progressKey(doc.id), fields);
    await this.redis.raw.expire(progressKey(doc.id), 3600);
  }

  /** 按 (documentId, stage) upsert 一条 ingestion_jobs，供观测/重跑判断各阶段成败 */
  private async trackJob(documentId: string, stage: IngestionStage, status: JobStatus, errorMsg?: string) {
    const existing = await this.jobs.findOne({ where: { documentId, stage } });
    if (existing) {
      await this.jobs.update(existing.id, { status, errorMsg: errorMsg ?? null });
    } else {
      await this.jobs.save(this.jobs.create({ documentId, stage, status, errorMsg: errorMsg ?? null }));
    }
  }
}
