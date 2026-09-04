/** 封闭实体类型（存 KnowledgeEntity.type 属性，不作为 Neo4j 标签） */
export const KG_ENTITY_TYPES = [
  'PERSON',
  'DEPARTMENT',
  'PROJECT',
  'COMPANY',
  'PRODUCT',
  'DOCUMENT',
] as const;

export type KgEntityType = (typeof KG_ENTITY_TYPES)[number];

/** 实体间语义关系（Neo4j 边类型固定 RELATED_TO，本枚举写入边属性 relation） */
export const KG_RELATION_TYPES = [
  'BELONGS_TO',
  'MANAGES',
  'PARTICIPATES_IN',
  'RESPONSIBLE_FOR',
  'DEPENDS_ON',
  'RELATED_TO',
] as const;

export type KgRelationType = (typeof KG_RELATION_TYPES)[number];

const ENTITY_TYPE_SET = new Set<string>(KG_ENTITY_TYPES);
const RELATION_TYPE_SET = new Set<string>(KG_RELATION_TYPES);

/** 旧枚举 / 口语别名 → 当前类型；对不上的丢掉，不再落到 CONCEPT */
const ENTITY_TYPE_ALIASES: Record<string, KgEntityType> = {
  PERSON: 'PERSON',
  PEOPLE: 'PERSON',
  DEPARTMENT: 'DEPARTMENT',
  DEPT: 'DEPARTMENT',
  PROJECT: 'PROJECT',
  COMPANY: 'COMPANY',
  ORG: 'COMPANY',
  ORGANIZATION: 'COMPANY',
  PRODUCT: 'PRODUCT',
  SYSTEM: 'PRODUCT',
  DOCUMENT: 'DOCUMENT',
  DOC: 'DOCUMENT',
};

const RELATION_TYPE_ALIASES: Record<string, KgRelationType> = {
  BELONGS_TO: 'BELONGS_TO',
  MANAGES: 'MANAGES',
  PARTICIPATES_IN: 'PARTICIPATES_IN',
  RESPONSIBLE_FOR: 'RESPONSIBLE_FOR',
  DEPENDS_ON: 'DEPENDS_ON',
  REQUIRES: 'DEPENDS_ON',
  RELATED_TO: 'RELATED_TO',
};

export function normalizeEntityType(raw: string | undefined | null): KgEntityType | null {
  const upper = (raw ?? '').trim().toUpperCase();
  if (ENTITY_TYPE_SET.has(upper)) return upper as KgEntityType;
  return ENTITY_TYPE_ALIASES[upper] ?? null;
}

export function normalizeRelationType(raw: string | undefined | null): KgRelationType {
  const upper = (raw ?? '').trim().toUpperCase();
  if (RELATION_TYPE_SET.has(upper)) return upper as KgRelationType;
  return RELATION_TYPE_ALIASES[upper] ?? 'RELATED_TO';
}

export interface KgExtractionLlmOutput {
  entities?: Array<{
    name?: string;
    type?: string;
    description?: string;
    aliases?: string[];
  }>;
  relations?: Array<{
    source?: string;
    target?: string;
    relation?: string;
    type?: string;
    weight?: number;
  }>;
}

export function buildExtractionSystemPrompt(maxEntities: number, maxRelations: number): string {
  return `你是知识图谱构建专家。请严格从文档片段中抽取知识实体和关系。

## 抽取规则
1. 只抽取文中明确提到的、属于下列 6 类的实体，不要臆测
2. 不要抽取概念、流程、地点、时间、政策条款、工具资源等；也不要抽过于泛化的词（如「系统」「功能」「数据」）
3. 实体名使用文中原文；别名放入 aliases
4. 关系必须有文中依据（同句或相邻句），且 source/target 必须是已抽取实体的 name
5. 每个片段最多 ${maxEntities} 个实体、${maxRelations} 个关系
6. 无法归入 6 类的实体直接跳过；关系无法归类时用 RELATED_TO

## 实体类型
- PERSON: 人物（如 张三、李四）
- DEPARTMENT: 部门（如 财务部、研发中心）
- PROJECT: 项目（如 星云ERP升级项目、智能工厂一期）
- COMPANY: 公司、供应商、客户（如 华云科技、天枢软件）
- PRODUCT: 产品、系统（如 星云ERP、知识库）
- DOCUMENT: 文档、规范（如 《员工手册》、财务评估报告）

## 关系类型
- BELONGS_TO: 归属、隶属于（人→部门，部门→公司，产品→公司）
- MANAGES: 管理（人→部门/项目）
- PARTICIPATES_IN: 参与（人/公司→项目）
- RESPONSIBLE_FOR: 负责（人/部门→项目或产品）
- DEPENDS_ON: 依赖（项目→产品/公司，产品→产品）
- RELATED_TO: 泛关联（兜底）

只返回 JSON，不要 markdown 或其它说明。关系对象的字段名是 relation（不要写成 type）。示例：
{"entities":[{"name":"张三","type":"PERSON","description":"财务总监","aliases":[]},{"name":"财务部","type":"DEPARTMENT","description":"","aliases":[]},{"name":"华云科技","type":"COMPANY","description":"","aliases":["华云"]},{"name":"星云ERP升级项目","type":"PROJECT","description":"","aliases":["星云ERP"]}],"relations":[{"source":"张三","target":"财务部","relation":"BELONGS_TO","weight":0.9},{"source":"财务部","target":"华云科技","relation":"BELONGS_TO","weight":0.8},{"source":"张三","target":"星云ERP升级项目","relation":"PARTICIPATES_IN","weight":0.8}]}`;
}
