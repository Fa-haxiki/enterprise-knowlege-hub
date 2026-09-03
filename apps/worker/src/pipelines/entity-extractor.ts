import { Injectable, Logger } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { LlmService } from '@ekh/api/modules/llm/llm.service';
import { ENTITY_TYPES, type EntityType, type ExtractedEntity } from '@ekh/api/modules/graph/graph.service';
import { cleanEntitySurface } from '@ekh/api/modules/graph/entity-normalizer';

/** 抽取实体：在 name/type 基础上带一句描述与原文别名，供对齐阶段做候选判定 */
export interface ExtractedEntityRich extends ExtractedEntity {
  /** ≤40 字的事实性描述（用于 embedding 与 LLM 判定，不含名字复述） */
  description: string;
  /** 原文中出现的其它写法：简称 / 全称 / 英文名 */
  aliases: string[];
}

export interface ExtractedRelation {
  source: string;
  sourceType: string;
  target: string;
  targetType: string;
  relation: string;
  confidence: number;
  /** 支撑该关系的原文片段（≤60 字），落到关系边便于溯源 */
  evidence?: string;
}

export interface ExtractionResult {
  entities: ExtractedEntityRich[];
  relations: ExtractedRelation[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** 抽取上下文：文档标题与章节路径，帮助模型消歧（如「本项目」指哪个项目） */
export interface ExtractionContext {
  title?: string;
  headingPath?: string[];
}

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);

const MAX_DESCRIPTION_CHARS = 80;
const MAX_EVIDENCE_CHARS = 120;
const MAX_ALIASES = 5;

/**
 * 泛化/噪声实体黑名单：这类词是类别统称或子任务名，不是具体实体。
 * 若允许入图，会成为「枢纽」把语义无关的节点串成孤岛链路（如 项目→财务相关供应商→项目）。
 * 命中即丢弃该实体及两端关系。
 */
const STOP_ENTITY_NAMES = new Set<string>([
  '项目', '供应商', '系统', '部门', '人员', '员工', '负责人', '团队', '公司', '企业',
  '财务相关供应商', '相关供应商', '外部供应商', '内部供应商', '服务', '方案', '产品',
  '本项目', '该项目', '本公司', '我司', '本部门', '该供应商', '本制度', '该制度',
  '主要财务制度', '相关制度', '公司制度', '财务制度',
]);
/** 指代式自称：「本办法」「本清单」「该项目」「上述供应商」——是对当前文档/上文的引用，不是实体名 */
const SELF_REFERENCE_RE = /^(本|该|此|上述|前述)[\u4e00-\u9fa5]{1,4}$/;

/** 名称是否为噪声：黑名单/指代式自称命中，或过短（<2 字，无辨识度） */
function isNoiseEntity(name: string): boolean {
  const n = (name ?? '').trim();
  if (n.length < 2) return true;
  return STOP_ENTITY_NAMES.has(n) || SELF_REFERENCE_RE.test(n);
}

/**
 * 关系类型签名：每种关系合法的 (sourceType -> targetType) 配对。
 * LLM 常把「供应商服务的项目的负责人是 X」误抽成「供应商 SERVES X」（Supplier→Person），
 * 产生供应商直连人名的孤岛链路。签名不合法的关系直接丢弃。
 */
const RELATION_SIGNATURE: Record<string, [string, string][]> = {
  USES_SUPPLIER: [['Project', 'Supplier']],
  SERVES: [['Supplier', 'Project']],
  OWNED_BY: [
    ['Project', 'Person'],
    ['Project', 'Department'],
  ],
  GOVERNED_BY: [
    ['Project', 'Policy'],
    ['Supplier', 'Policy'],
    ['Department', 'Policy'],
  ],
  PUBLISHES: [['Department', 'Policy']],
  PARTICIPATES_IN: [['Person', 'Project']],
  BELONGS_TO: [['Person', 'Department']],
};

/** 关系两端类型配对是否合法（未登记的关系类型默认放行，由 RELATION_TYPES 白名单兜底） */
function isValidRelation(sourceType: string, targetType: string, relation: string): boolean {
  const sig = RELATION_SIGNATURE[relation];
  if (!sig) return true;
  return sig.some(([s, t]) => s === sourceType && t === targetType);
}

const SYSTEM_PROMPT =
  '从文本中抽取企业知识图谱实体与关系。\n' +
  `实体类型限于：${ENTITY_TYPES.join('/')}。\n` +
  '实体名称统一使用中文规范名（如 Finance → 财务部、HR → 人力资源部）；' +
  '仅当实体在原文中没有中文对应（如 ERP、OKR 等通用缩写）时保留原文；' +
  '同一实体的中英文/全称简称等不同写法必须合并为同一个实体：name 用最完整的规范写法，其它写法放进 aliases。\n' +
  '实体必须是【具体、可辨识的专有名称】（如「星云ERP升级项目」「华云科技」「郑浩然」）；' +
  '禁止抽取泛化类别词、指代词或子任务名作为实体，如「项目」「供应商」「本项目」「财务相关供应商」「ERP费控实施」等。\n' +
  '每个实体给出 description：≤40 字、只写原文中的事实（职务/归属/业务/用途等），不要复述名字，没有信息则为空字符串。\n' +
  '【文档上下文】中的标题仅用于消歧（如判断「本项目」指哪个项目），文件编号前缀（如 03-）、扩展名（.pdf）、书名号《》' +
  '都不属于名称，不得出现在 name/aliases 中；「本办法」「本清单」这类指代也不是别名。\n' +
  '关系类型用大写下划线英文动词，且两端实体类型必须匹配：\n' +
  '- USES_SUPPLIER：Project → Supplier（项目使用供应商）\n' +
  '- SERVES：Supplier → Project（供应商服务项目，target 必须是项目，不能是人）\n' +
  '- OWNED_BY：Project → Person/Department（项目负责人/归属部门）\n' +
  '- GOVERNED_BY：Project/Supplier/Department → Policy（受制度约束）\n' +
  '- PUBLISHES：Department → Policy（部门发布制度）\n' +
  '- PARTICIPATES_IN：Person → Project（人参与项目）\n' +
  '- BELONGS_TO：Person → Department（人属于部门）\n' +
  '「供应商服务的项目的负责人是X」应拆成两条：供应商 SERVES 项目、项目 OWNED_BY X；不得抽成 供应商 SERVES X。\n' +
  '每条关系给出 evidence：支撑该关系的原文片段（≤60 字，原文摘录不改写）。\n' +
  '只输出 JSON：{"entities":[{"name","type","description","aliases":[]}],' +
  '"relations":[{"source","sourceType","target","targetType","relation","confidence","evidence"}]}。\n' +
  'confidence 取 0-1；无内容可抽取时输出 {"entities":[],"relations":[]}。';

/** LLM 实体/关系抽取（JSON Schema 约束输出） */
@Injectable()
export class EntityExtractor {
  private readonly logger = new Logger(EntityExtractor.name);

  constructor(private readonly llm: LlmService) {}

  async extract(text: string, context?: ExtractionContext): Promise<ExtractionResult> {
    const { text: raw, usage } = await this.llm.invokeWithUsage(
      [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(this.buildInput(text, context))],
      { ...this.llm.routerProfile(), temperature: 0, timeout: 90_000 },
    );

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : raw) as {
        entities?: Partial<ExtractedEntityRich>[];
        relations?: Partial<ExtractedRelation>[];
      };
      const entities: ExtractedEntityRich[] = [];
      for (const e of parsed.entities ?? []) {
        if (!e || typeof e.name !== 'string' || !ENTITY_TYPE_SET.has(e.type as string)) continue;
        const name = cleanEntitySurface(e.name);
        if (isNoiseEntity(name)) continue;
        const aliases = Array.isArray(e.aliases)
          ? [...new Set(e.aliases.filter((a): a is string => typeof a === 'string').map(cleanEntitySurface))]
              .filter((a) => a && a !== name && !isNoiseEntity(a))
              .slice(0, MAX_ALIASES)
          : [];
        entities.push({
          name,
          type: e.type as EntityType,
          description: typeof e.description === 'string' ? e.description.trim().slice(0, MAX_DESCRIPTION_CHARS) : '',
          aliases,
        });
      }
      const relations = (parsed.relations ?? [])
        .filter(
          (r): r is ExtractedRelation =>
            !!r &&
            typeof r.source === 'string' &&
            typeof r.target === 'string' &&
            ENTITY_TYPE_SET.has(r.sourceType as string) &&
            ENTITY_TYPE_SET.has(r.targetType as string) &&
            typeof r.relation === 'string' &&
            /^[A-Z_]+$/.test(r.relation) &&
            isValidRelation(r.sourceType as string, r.targetType as string, r.relation),
        )
        .map((r) => ({
          source: cleanEntitySurface(r.source),
          sourceType: r.sourceType,
          target: cleanEntitySurface(r.target),
          targetType: r.targetType,
          relation: r.relation,
          confidence: typeof r.confidence === 'number' ? Math.min(Math.max(r.confidence, 0), 1) : 0.5,
          evidence: typeof r.evidence === 'string' ? r.evidence.trim().slice(0, MAX_EVIDENCE_CHARS) : undefined,
        }))
        // 端点清洗后再过噪声：《本办法》→ 本办法 这类指代端点在清洗前不会命中黑名单
        .filter((r) => !isNoiseEntity(r.source) && !isNoiseEntity(r.target));
      return { entities, relations, usage };
    } catch (e) {
      this.logger.warn(`entity extraction parse failed: ${(e as Error).message}`);
      return { entities: [], relations: [], usage };
    }
  }

  /** 正文前置《标题》与章节路径：分块后「本项目」等指代需要文档级上下文才能落到具体实体 */
  private buildInput(text: string, context?: ExtractionContext): string {
    const body = text.slice(0, 6000);
    const title = context?.title?.trim();
    if (!title) return body;
    const path = (context?.headingPath ?? []).filter(Boolean).join(' > ');
    const header = path ? `《${title}》 > ${path}` : `《${title}》`;
    return `【文档上下文】${header}\n\n${body}`;
  }
}
