import { Injectable, Logger } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { LlmService } from '@ekh/api/modules/llm/llm.service';
import { ENTITY_TYPES, type ExtractedEntity } from '@ekh/api/modules/graph/graph.service';

export interface ExtractedRelation {
  source: string;
  sourceType: string;
  target: string;
  targetType: string;
  relation: string;
  confidence: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);

/**
 * 泛化/噪声实体黑名单：这类词是类别统称或子任务名，不是具体实体。
 * 若允许入图，会成为「枢纽」把语义无关的节点串成孤岛链路（如 项目→财务相关供应商→项目）。
 * 命中即丢弃该实体及两端关系。
 */
const STOP_ENTITY_NAMES = new Set<string>([
  '项目', '供应商', '系统', '部门', '人员', '员工', '负责人', '团队', '公司', '企业',
  '财务相关供应商', '相关供应商', '外部供应商', '内部供应商', '服务', '方案', '产品',
]);

/** 名称是否为噪声：黑名单命中，或去空格后过短（<2 字，无辨识度） */
function isNoiseEntity(name: string): boolean {
  const n = name.trim();
  if (n.length < 2) return true;
  return STOP_ENTITY_NAMES.has(n);
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

/** LLM 实体/关系抽取（JSON Schema 约束输出） */
@Injectable()
export class EntityExtractor {
  private readonly logger = new Logger(EntityExtractor.name);

  constructor(private readonly llm: LlmService) {}

  async extract(text: string): Promise<ExtractionResult> {
    const { text: raw, usage } = await this.llm.invokeWithUsage(
      [
        new SystemMessage(
          '从文本中抽取企业知识图谱实体与关系。\n' +
            `实体类型限于：${ENTITY_TYPES.join('/')}。\n` +
            '实体名称统一使用中文规范名（如 Finance → 财务部、HR → 人力资源部）；' +
            '仅当实体在原文中没有中文对应（如 ERP、OKR 等通用缩写）时保留原文；' +
            '同一实体的中英文/全称简称等不同写法必须合并为同一个中文规范名。\n' +
            '实体必须是【具体、可辨识的专有名称】（如「星云ERP升级项目」「华云科技」「郑浩然」）；' +
            '禁止抽取泛化类别词或子任务名作为实体，如「项目」「供应商」「系统」「财务相关供应商」「ERP费控实施」等。\n' +
            '关系类型用大写下划线英文动词，且两端实体类型必须匹配：\n' +
            '- USES_SUPPLIER：Project → Supplier（项目使用供应商）\n' +
            '- SERVES：Supplier → Project（供应商服务项目，target 必须是项目，不能是人）\n' +
            '- OWNED_BY：Project → Person/Department（项目负责人/归属部门）\n' +
            '- GOVERNED_BY：Project/Supplier/Department → Policy（受制度约束）\n' +
            '- PUBLISHES：Department → Policy（部门发布制度）\n' +
            '- PARTICIPATES_IN：Person → Project（人参与项目）\n' +
            '- BELONGS_TO：Person → Department（人属于部门）\n' +
            '「供应商服务的项目的负责人是X」应拆成两条：供应商 SERVES 项目、项目 OWNED_BY X；不得抽成 供应商 SERVES X。\n' +
            '只输出 JSON：{"entities":[{"name","type"}],"relations":[{"source","sourceType","target","targetType","relation","confidence"}]}。\n' +
            'confidence 取 0-1；无内容可抽取时输出 {"entities":[],"relations":[]}。',
        ),
        new HumanMessage(text.slice(0, 6000)),
      ],
      { temperature: 0, timeout: 120_000 },
    );

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : raw) as ExtractionResult;
      return {
        entities: (parsed.entities ?? []).filter(
          (e): e is ExtractedEntity => ENTITY_TYPE_SET.has(e.type) && !isNoiseEntity(e.name),
        ),
        relations: (parsed.relations ?? []).filter(
          (r) =>
            r.source &&
            r.target &&
            ENTITY_TYPE_SET.has(r.sourceType) &&
            ENTITY_TYPE_SET.has(r.targetType) &&
            /^[A-Z_]+$/.test(r.relation) &&
            !isNoiseEntity(r.source) &&
            !isNoiseEntity(r.target) &&
            isValidRelation(r.sourceType, r.targetType, r.relation),
        ),
        usage,
      };
    } catch (e) {
      this.logger.warn(`entity extraction parse failed: ${(e as Error).message}`);
      return { entities: [], relations: [], usage };
    }
  }
}
