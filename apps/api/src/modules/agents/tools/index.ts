import { ToolName } from '@ekh/shared';

export const AGENT_TOOL_SCHEMAS = [
  {
    name: ToolName.KB_RETRIEVE,
    description: '从企业内部知识库混合检索相关分片（ES + 向量 + Rerank）',
    schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: ToolName.GRAPH_REASON,
    description: '对多实体关系/对比/追溯问题做知识图谱多跳推理并补召回',
    schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: ToolName.WEB_SEARCH,
    description: '检索公开互联网最新信息，不用于查询企业内部制度',
    schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
] as const;

export { WebSearchService } from './web-search.service';
