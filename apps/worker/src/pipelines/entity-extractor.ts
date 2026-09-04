import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { LlmService } from '@ekh/api/modules/llm/llm.service';
import type { ExtractedEntity, ExtractedRelation } from '@ekh/api/modules/graph/graph.service';
import {
  buildExtractionSystemPrompt,
  normalizeEntityType,
  normalizeRelationType,
  type KgExtractionLlmOutput,
} from './kg-extraction.schema';

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/** LLM 实体/关系抽取：标题+章节作上下文，类型归范，丢掉悬空关系 */
@Injectable()
export class EntityExtractor {
  private readonly logger = new Logger(EntityExtractor.name);
  private readonly maxEntities: number;
  private readonly maxRelations: number;

  constructor(
    private readonly llm: LlmService,
    config: ConfigService,
  ) {
    this.maxEntities = config.get<number>('kg.maxEntities') ?? 12;
    this.maxRelations = config.get<number>('kg.maxRelations') ?? 15;
  }

  async extract(
    text: string,
    heading?: string | null,
    documentTitle?: string,
  ): Promise<ExtractionResult> {
    if (!text?.trim()) return { entities: [], relations: [] };

    const { text: raw, usage } = await this.llm.invokeWithUsage(
      [
        new SystemMessage(buildExtractionSystemPrompt(this.maxEntities, this.maxRelations)),
        new HumanMessage(
          `文档标题: ${documentTitle ?? '无'}\n章节: ${heading ?? '无'}\n\n内容:\n${text.slice(0, 4000)}`,
        ),
      ],
      { temperature: 0.1, timeout: 120_000 },
    );

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : raw) as KgExtractionLlmOutput;
      return { ...this.toExtractionResult(parsed), usage };
    } catch (e) {
      this.logger.warn(`entity extraction parse failed: ${(e as Error).message}`);
      return { entities: [], relations: [], usage };
    }
  }

  private toExtractionResult(parsed: KgExtractionLlmOutput): ExtractionResult {
    const entityNames = new Set<string>();
    const entities: ExtractedEntity[] = [];
    for (const e of (parsed.entities ?? []).slice(0, this.maxEntities)) {
      const name = (e.name ?? '').trim();
      const type = normalizeEntityType(e.type);
      if (!name || !type) continue;
      entityNames.add(name);
      entities.push({
        name,
        type,
        description: (e.description ?? '').trim(),
        aliases: (e.aliases ?? []).map((a) => String(a).trim()).filter(Boolean),
      });
    }

    const relations: ExtractedRelation[] = [];
    for (const r of (parsed.relations ?? []).slice(0, this.maxRelations)) {
      const source = (r.source ?? '').trim();
      const target = (r.target ?? '').trim();
      if (!source || !target || !entityNames.has(source) || !entityNames.has(target)) continue;
      relations.push({
        source,
        target,
        relation: normalizeRelationType(r.relation ?? r.type),
        weight: typeof r.weight === 'number' ? r.weight : 0.5,
      });
    }

    return { entities, relations };
  }
}
