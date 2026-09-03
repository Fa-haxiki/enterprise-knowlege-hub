import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  GraphService,
  type AlignedEntityWrite,
  type AlignedGraphWrite,
  type AlignedRelationWrite,
  type EntityCandidate,
  type EntityType,
} from '@ekh/api/modules/graph/graph.service';
import {
  ENTITY_TYPE_ZH,
  cosineSimilarity,
  isNameContained,
  nameSimilarity,
  normalizeEntityName,
} from '@ekh/api/modules/graph/entity-normalizer';
import { EmbeddingService } from '@ekh/api/modules/llm/embedding.service';
import { RedisService } from '@ekh/api/redis/redis.service';
import { LangfuseService, type TraceHandle } from '@ekh/api/modules/observability/langfuse.service';
import type { ExtractionResult } from './entity-extractor';

export interface AlignInput {
  workspaceId: string;
  documentId: string;
  /** 每个分片的抽取结果；抽取失败的分片为 null */
  chunks: { chunkId: string; extraction: ExtractionResult | null }[];
}

export interface AlignStats {
  docEntities: number;
  ruleMerged: number;
  autoMerged: number;
  intraMerged: number;
  created: number;
  relations: number;
}

/** 文档内归并后的实体：同一类型下多种写法收敛成一个待对齐单元 */
interface DocEntity {
  type: EntityType;
  /** 规范名：出现次数最多的实体名（并列取更长者） */
  name: string;
  normName: string;
  /** 全部表面写法（含 name），用于回填别名与关系端点解析 */
  surfaces: Set<string>;
  normForms: Set<string>;
  descriptions: string[];
  chunkIds: Set<string>;
  embedding?: number[];
}

/** 描述合并后的最大长度 */
const MAX_DESCRIPTION_CHARS = 160;
/** 名称字面相似度门槛：向量通道需名称沾边才合并（防止「华云科技」「星云科技」被误合） */
const AUTO_MERGE_NAME_SIM = 0.5;

const LOCK_TTL_MS = 10 * 60_000;
const LOCK_WAIT_MS = 20 * 60_000;
const LOCK_POLL_MS = 1_000;

const RELEASE_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** 并查集：文档内实体归并与对齐结果解析都靠它 */
class UnionFind {
  private readonly parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * 实体对齐：把单文档抽取出的实体挂到工作空间已有的规范实体上（找不到则新建），再按实体 id 写关系。
 *
 * 流程：文档内归并（规则）→ 批量 embedding → 候选召回（精确/别名命中 ∪ 向量 kNN）
 *      → 判定矩阵（规则合并 / 名称沾边+向量合并 / 纯高相似合并 / 其余新建）→ 并查集解析 → 落图。
 * 不做 LLM 成对判定：灰区也只靠 embedding + 名称规则，避免对齐阶段再烧对话额度。
 * 候选召回到落图全程持有 workspace 级 Redis 锁：两份并行入库的文档若同时新建同一实体会造成重复节点。
 */
@Injectable()
export class EntityAligner {
  private readonly logger = new Logger(EntityAligner.name);

  constructor(
    private readonly graphDb: GraphService,
    private readonly embedding: EmbeddingService,
    private readonly redis: RedisService,
    private readonly langfuse: LangfuseService,
    private readonly config: ConfigService,
  ) {}

  /** 对齐并写图；返回统计用于日志与 Langfuse */
  async alignAndWrite(input: AlignInput, trace?: TraceHandle | null): Promise<AlignStats> {
    const span = this.langfuse.createSpan(trace ?? null, 'align', {
      documentId: input.documentId,
      chunks: input.chunks.length,
    });
    try {
      const { entities, keyToEntity } = this.mergeWithinDocument(input);
      const stats: AlignStats = {
        docEntities: entities.length,
        ruleMerged: 0,
        autoMerged: 0,
        intraMerged: 0,
        created: 0,
        relations: 0,
      };
      if (entities.length === 0) {
        this.langfuse.endSpan(span, { ...stats });
        return stats;
      }

      await this.embedEntities(entities, trace);

      const write = await this.withWorkspaceLock(input.workspaceId, async () => {
        const payload = await this.resolve(input, entities, keyToEntity, stats);
        await this.graphDb.writeAlignedGraph(payload);
        return payload;
      });

      stats.relations = write.relations.length;
      this.logger.log(
        `align ${input.documentId}: entities=${stats.docEntities} rule=${stats.ruleMerged} auto=${stats.autoMerged} ` +
          `intra=${stats.intraMerged} created=${stats.created} relations=${stats.relations}`,
      );
      this.langfuse.endSpan(span, { ...stats });
      return stats;
    } catch (e) {
      this.langfuse.endSpan(span, {}, e as Error);
      throw e;
    }
  }

  // ---------------- 1. 文档内归并 ----------------

  /**
   * 同类型下 归一化名相同 或 被声明为别名 的写法并成一个 DocEntity。
   * 关系端点若未出现在实体列表中，也补成实体（否则关系无处落）。
   */
  private mergeWithinDocument(input: AlignInput): { entities: DocEntity[]; keyToEntity: Map<string, number> } {
    interface Surface {
      key: string;
      type: EntityType;
      surface: string;
      norm: string;
      isName: boolean;
      count: number;
      descriptions: string[];
      chunkIds: Set<string>;
      aliasKeys: Set<string>;
    }
    const surfaces = new Map<string, Surface>();
    const touch = (type: EntityType, surface: string, chunkId: string, isName: boolean): Surface | null => {
      const norm = normalizeEntityName(surface, type);
      if (!norm) return null;
      const key = `${type}|${norm}`;
      let s = surfaces.get(key);
      if (!s) {
        s = { key, type, surface, norm, isName, count: 0, descriptions: [], chunkIds: new Set(), aliasKeys: new Set() };
        surfaces.set(key, s);
      }
      if (isName) {
        s.count++;
        // 同一归一化名下保留更长的表面形作为展示名
        if (!s.isName || surface.length > s.surface.length) s.surface = surface;
        s.isName = true;
      }
      s.chunkIds.add(chunkId);
      return s;
    };

    for (const { chunkId, extraction } of input.chunks) {
      if (!extraction) continue;
      for (const e of extraction.entities) {
        const s = touch(e.type, e.name, chunkId, true);
        if (!s) continue;
        if (e.description) s.descriptions.push(e.description);
        for (const alias of e.aliases) {
          const a = touch(e.type, alias, chunkId, false);
          if (a && a.key !== s.key) s.aliasKeys.add(a.key);
        }
      }
      for (const r of extraction.relations) {
        touch(r.sourceType as EntityType, r.source, chunkId, true);
        touch(r.targetType as EntityType, r.target, chunkId, true);
      }
    }

    const list = [...surfaces.values()];
    const indexOf = new Map(list.map((s, i) => [s.key, i]));
    const uf = new UnionFind(list.length);
    for (const s of list) {
      for (const ak of s.aliasKeys) {
        const j = indexOf.get(ak);
        if (j !== undefined) uf.union(indexOf.get(s.key)!, j);
      }
    }

    const groups = new Map<number, Surface[]>();
    list.forEach((s, i) => {
      const root = uf.find(i);
      groups.set(root, [...(groups.get(root) ?? []), s]);
    });

    const entities: DocEntity[] = [];
    const keyToEntity = new Map<string, number>();
    for (const members of groups.values()) {
      const named = members.filter((m) => m.isName);
      const pool = named.length > 0 ? named : members;
      const head = [...pool].sort((a, b) => b.count - a.count || b.surface.length - a.surface.length)[0];
      const entity: DocEntity = {
        type: head.type,
        name: head.surface,
        normName: head.norm,
        surfaces: new Set(members.map((m) => m.surface)),
        normForms: new Set(members.map((m) => m.norm)),
        descriptions: members.flatMap((m) => m.descriptions),
        chunkIds: new Set(members.flatMap((m) => [...m.chunkIds])),
      };
      const idx = entities.push(entity) - 1;
      for (const m of members) keyToEntity.set(m.key, idx);
    }
    return { entities, keyToEntity };
  }

  // ---------------- 2. embedding ----------------

  private async embedEntities(entities: DocEntity[], trace?: TraceHandle | null) {
    const texts = entities.map((e) => this.embeddingText(e));
    const generation = this.langfuse.createGeneration(trace ?? null, {
      name: 'entity_embedding',
      model: this.config.get<string>('embedding.model') ?? 'unknown',
      input: { entities: texts.length },
    });
    try {
      const { vectors, usage } = await this.embedding.embedWithUsage(texts);
      entities.forEach((e, i) => (e.embedding = vectors[i]));
      this.langfuse.endGeneration(generation, {
        output: `embedded ${texts.length} entities`,
        usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: 0 },
      });
    } catch (e) {
      this.langfuse.endGeneration(generation, {
        output: `failed: ${(e as Error).message}`,
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      });
      throw e;
    }
  }

  /** 向量化文本：名称 + 类型 + 别名 + 描述，让「简称 + 业务描述」也能靠近全称实体 */
  private embeddingText(e: DocEntity): string {
    const aliases = [...e.surfaces].filter((s) => s !== e.name);
    const alias = aliases.length > 0 ? `，又称 ${aliases.slice(0, 5).join(' / ')}` : '';
    const desc = this.mergeDescriptions(e.descriptions);
    return `${e.name}（${ENTITY_TYPE_ZH[e.type] ?? e.type}${alias}）${desc ? `：${desc}` : ''}`;
  }

  private mergeDescriptions(descriptions: string[]): string {
    const uniq = [...new Set(descriptions.map((d) => d.trim()).filter(Boolean))].sort(
      (a, b) => b.length - a.length,
    );
    let out = '';
    for (const d of uniq) {
      if (out && out.includes(d)) continue;
      const next = out ? `${out}；${d}` : d;
      if (next.length > MAX_DESCRIPTION_CHARS) break;
      out = next;
    }
    return out;
  }

  // ---------------- 3-6. 候选召回 → 判定 → 解析 ----------------

  private async resolve(
    input: AlignInput,
    entities: DocEntity[],
    keyToEntity: Map<string, number>,
    stats: AlignStats,
  ): Promise<AlignedGraphWrite> {
    const autoCos = this.config.get<number>('graph.alignAutoCos') ?? 0.9;
    // 名称沾边时放低向量门槛：同指对因描述差异常落在 0.6~0.75，不再交 LLM
    const mergeCos = this.config.get<number>('graph.alignMergeCos') ?? 0.55;
    const shouldMerge = (cos: number, e: DocEntity, other: { normName: string; normAliases: string[] }) =>
      cos >= autoCos || (cos >= mergeCos && this.namesRelated(e, other));

    /** 每个文档实体挂到的已有实体（规则 / embedding 合并结果） */
    const attached = new Map<number, EntityCandidate>();
    const uf = new UnionFind(entities.length);

    // 3a. 规则通道：归一化名 / 别名精确命中
    const byType = new Map<EntityType, number[]>();
    entities.forEach((e, i) => byType.set(e.type, [...(byType.get(e.type) ?? []), i]));
    for (const [type, idxs] of byType) {
      const norms = [...new Set(idxs.flatMap((i) => [...entities[i].normForms]))];
      const hits = await this.graphDb.findExact([input.workspaceId], type, norms);
      if (hits.length === 0) continue;
      const byNorm = new Map<string, EntityCandidate>();
      for (const h of hits) {
        // 规范名命中优先于别名命中
        if (!byNorm.has(h.normName)) byNorm.set(h.normName, h);
        for (const a of h.normAliases) if (!byNorm.has(a)) byNorm.set(a, h);
      }
      for (const i of idxs) {
        const hit = [...entities[i].normForms].map((n) => byNorm.get(n)).find(Boolean);
        if (hit) {
          attached.set(i, hit);
          stats.ruleMerged++;
        }
      }
    }

    // 3b. 向量通道：未命中规则的实体做 kNN，按判定矩阵分流
    for (let i = 0; i < entities.length; i++) {
      if (attached.has(i)) continue;
      const e = entities[i];
      if (!e.embedding) continue;
      const candidates = await this.graphDb.findSimilar([input.workspaceId], e.type, e.embedding);
      if (candidates.length === 0) continue;
      this.logger.debug(
        `align candidates ${e.type}/${e.name}: ` +
          candidates.map((c) => `${c.name}@${c.score.toFixed(3)}`).join(', '),
      );
      const hit = candidates.find((c) => shouldMerge(c.score, e, c));
      if (hit) {
        attached.set(i, hit);
        stats.autoMerged++;
      }
    }

    // 3c. 文档内新实体两两比对（同类型）：规范名不同但可能同指的写法（如「华云科技有限公司」与「华云」）
    for (const idxs of byType.values()) {
      for (let x = 0; x < idxs.length; x++) {
        for (let y = x + 1; y < idxs.length; y++) {
          const i = idxs[x];
          const j = idxs[y];
          if (attached.has(i) && attached.has(j)) continue;
          const a = entities[i];
          const b = entities[j];
          if (!a.embedding || !b.embedding) continue;
          const cos = cosineSimilarity(a.embedding, b.embedding);
          const other = { normName: b.normName, normAliases: [...b.normForms] };
          if (shouldMerge(cos, a, other)) {
            uf.union(i, j);
            stats.intraMerged++;
          }
        }
      }
    }

    // 4. 并查集解析：组内任一成员挂到已有实体 → 整组归入该实体；否则新建
    const groups = new Map<number, number[]>();
    entities.forEach((_, i) => {
      const root = uf.find(i);
      groups.set(root, [...(groups.get(root) ?? []), i]);
    });

    const entityWrites: AlignedEntityWrite[] = [];
    const resolvedId = new Map<number, string>();
    for (const members of groups.values()) {
      const existing = members.map((i) => attached.get(i)).filter((c): c is EntityCandidate => !!c);
      const surfaces = new Set(members.flatMap((i) => [...entities[i].surfaces]));
      const descriptions = members.flatMap((i) => entities[i].descriptions);
      const chunkIds = [...new Set(members.flatMap((i) => [...entities[i].chunkIds]))];
      const type = entities[members[0]].type;

      if (existing.length > 0) {
        // 组内挂到了多个不同已有实体：说明库里已有重复，取相似度最高者，其余留待后续治理
        const target = [...existing].sort((a, b) => b.score - a.score)[0];
        const distinct = new Set(existing.map((c) => c.id));
        if (distinct.size > 1) {
          this.logger.warn(
            `align group hits ${distinct.size} existing entities (${[...existing.map((c) => c.name)].join(' / ')}), attach to ${target.name}`,
          );
        }
        const aliases = [...surfaces].filter((s) => s !== target.name && !target.aliases.includes(s));
        entityWrites.push({
          id: target.id,
          type,
          name: target.name,
          normName: target.normName,
          aliases,
          normAliases: aliases.map((a) => normalizeEntityName(a, type)).filter(Boolean),
          description: this.mergeDescriptions([target.description, ...descriptions]),
          isNew: false,
          mentionChunkIds: chunkIds,
        });
        members.forEach((i) => resolvedId.set(i, target.id));
        continue;
      }

      const head = [...members]
        .map((i) => entities[i])
        .sort((a, b) => b.chunkIds.size - a.chunkIds.size || b.name.length - a.name.length)[0];
      const id = randomUUID();
      const aliases = [...surfaces].filter((s) => s !== head.name);
      entityWrites.push({
        id,
        type,
        name: head.name,
        normName: head.normName,
        aliases,
        normAliases: [...new Set(aliases.map((a) => normalizeEntityName(a, type)).filter((n) => n && n !== head.normName))],
        description: this.mergeDescriptions(descriptions),
        embedding: head.embedding,
        isNew: true,
        mentionChunkIds: chunkIds,
      });
      members.forEach((i) => resolvedId.set(i, id));
      stats.created++;
    }

    // 6. 关系端点映射到实体 id
    const relations: AlignedRelationWrite[] = [];
    const seen = new Set<string>();
    for (const { chunkId, extraction } of input.chunks) {
      if (!extraction) continue;
      for (const r of extraction.relations) {
        const si = keyToEntity.get(`${r.sourceType}|${normalizeEntityName(r.source, r.sourceType)}`);
        const ti = keyToEntity.get(`${r.targetType}|${normalizeEntityName(r.target, r.targetType)}`);
        if (si === undefined || ti === undefined) continue;
        const sourceId = resolvedId.get(si);
        const targetId = resolvedId.get(ti);
        if (!sourceId || !targetId || sourceId === targetId) continue;
        const dedupe = `${sourceId}|${r.relation}|${targetId}|${chunkId}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        relations.push({ sourceId, targetId, relation: r.relation, confidence: r.confidence, evidence: r.evidence, chunkId });
      }
    }

    return {
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      chunkIds: input.chunks.map((c) => c.chunkId),
      entities: entityWrites,
      relations,
    };
  }

  /** 高向量相似度之外的名称校验：任一写法互含，或 bigram 相似度过线 */
  private namesRelated(e: DocEntity, other: { normName: string; normAliases: string[] }): boolean {
    const theirs = [other.normName, ...other.normAliases].filter(Boolean);
    for (const mine of e.normForms) {
      for (const t of theirs) {
        if (isNameContained(mine, t) || nameSimilarity(mine, t) >= AUTO_MERGE_NAME_SIM) return true;
      }
    }
    return false;
  }

  // ---------------- 并发保护 ----------------

  /** workspace 级互斥：SET NX PX 抢锁，轮询等待；释放时校验 token 防止误删他人锁 */
  private async withWorkspaceLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const key = `graph:align:${workspaceId}`;
    const token = randomUUID();
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const ok = await this.redis.raw.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
      if (ok === 'OK') break;
      if (Date.now() > deadline) throw new Error(`align lock wait timeout for workspace ${workspaceId}`);
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      await this.redis.raw.eval(RELEASE_LOCK_LUA, 1, key, token).catch(() => undefined);
    }
  }
}
