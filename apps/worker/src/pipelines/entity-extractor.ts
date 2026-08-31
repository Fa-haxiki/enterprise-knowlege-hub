import { Injectable, Logger } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { LlmService } from '@ekh/api/modules/llm/llm.service';
import type { ExtractedEntity } from '@ekh/api/modules/graph/graph.service';

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

const ENTITY_TYPES = ['Project', 'Supplier', 'Person', 'Policy', 'Department'];

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
            '关系类型用大写下划线英文动词，如 USES_SUPPLIER / OWNED_BY / GOVERNED_BY / PUBLISHES / SERVES。\n' +
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
        entities: (parsed.entities ?? []).filter((e) => ENTITY_TYPES.includes(e.type)),
        relations: (parsed.relations ?? []).filter(
          (r) => r.source && r.target && /^[A-Z_]+$/.test(r.relation),
        ),
        usage,
      };
    } catch (e) {
      this.logger.warn(`entity extraction parse failed: ${(e as Error).message}`);
      return { entities: [], relations: [], usage };
    }
  }
}
