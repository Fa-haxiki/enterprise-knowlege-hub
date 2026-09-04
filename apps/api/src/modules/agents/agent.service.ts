import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Complexity, type Citation, type ChunkHit, type Triple } from '@ekh/shared';
import { AclService } from '../workspaces/acl.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { MemoryService } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';
import { LangfuseService, type TraceHandle } from '../observability/langfuse.service';
import { GRAPH_RELATION_TYPES, GraphService } from '../graph/graph.service';
import { AgentStateAnnotation, type AgentCallbacks, type AgentState } from './agent.state';

const RELATION_TYPE_SET = new Set<string>(GRAPH_RELATION_TYPES);

const NODE_TIMEOUTS: Record<string, number> = {
  query_rewrite: 5_000,
  complexity_router: 10_000,
  hybrid_retrieve: 8_000,
  graph_reason: 8_000,
  memory_load: 3_000,
};

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly graph: ReturnType<typeof this.buildGraph>;

  constructor(
    private readonly acl: AclService,
    private readonly retrieval: RetrievalService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
    private readonly graphDb: GraphService,
    private readonly langfuse: LangfuseService,
    private readonly config: ConfigService,
  ) {
    this.graph = this.buildGraph();
  }

  /** 执行问答全链路，callbacks 用于 SSE 流式推送；返回 state 与 LangFuse traceId */
  async run(
    input: {
      query: string;
      userId: string;
      conversationId: string;
      workspaceId?: string;
      enableGraph: boolean;
    },
    callbacks: AgentCallbacks,
  ): Promise<{ state: AgentState; traceId: string | null }> {
    const trace = this.langfuse.createTrace('chat_completion', {
      userId: input.userId,
      conversationId: input.conversationId,
    });

    const result = (await this.graph.invoke(
      {
        query: input.query,
        userId: input.userId,
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        enableGraph: input.enableGraph,
      },
      { configurable: { callbacks, trace } },
    )) as AgentState;

    trace?.update({
      output: result.answer.slice(0, 500),
      metadata: {
        complexity: result.complexity,
        degraded: result.degraded,
        nodeLatencies: result.nodeLatencies,
        recalledChunkIds: result.rerankedChunks.map((c) => c.chunk_id),
        graphTriples: result.graphTriples.length,
      },
    });
    return { state: result, traceId: trace?.id ?? null };
  }

  /**
   * 问答状态机：START → … → llm_generate → END。
   * 仅 hybrid_retrieve 之后有分支：complex 且开启图谱才走 graph_reason。
   */
  private buildGraph() {
    const g = new StateGraph(AgentStateAnnotation)
      // 加载用户可见空间白名单（检索 ACL 前置过滤）
      .addNode('acl_guard', this.wrap('acl_guard', this.aclGuard.bind(this)))
      // 读取 Redis 短期窗口 + 滚动摘要（供改写与 Prompt）
      .addNode('load_window', this.wrap('load_window', this.loadWindow.bind(this)))
      // 结合对话历史做指代消解，改写成独立问题
      .addNode('query_rewrite', this.wrap('query_rewrite', this.queryRewrite.bind(this)))
      // LLM 二分类 simple/complex，并抽出实体供图谱使用
      .addNode('complexity_router', this.wrap('complexity_router', this.complexityRouter.bind(this)))
      // ES + PGVector 双路召回 → RRF 融合 → Rerank Top-N
      .addNode('hybrid_retrieve', this.wrap('hybrid_retrieve', this.hybridRetrieve.bind(this)))
      // Neo4j 多跳推理 + 图增强补召回（仅 complex 路径）
      .addNode('graph_reason', this.wrap('graph_reason', this.graphReason.bind(this)))
      // 拉取 Mem0 长期记忆（user / session）
      .addNode('memory_load', this.wrap('memory_load', this.memoryLoad.bind(this)))
      // 把记忆、分片、图谱三元组拼成最终 Prompt
      .addNode('prompt_build', this.wrap('prompt_build', this.promptBuild.bind(this)))
      // LLM 流式生成答案，并把 [n] 对齐成 citation
      .addNode('llm_generate', this.wrap('llm_generate', this.llmGenerate.bind(this)))
      .addEdge(START, 'acl_guard')
      .addEdge('acl_guard', 'load_window')
      .addEdge('load_window', 'query_rewrite')
      .addEdge('query_rewrite', 'complexity_router')
      .addEdge('complexity_router', 'hybrid_retrieve')
      .addConditionalEdges('hybrid_retrieve', (state: AgentState) =>
        state.complexity === Complexity.COMPLEX && state.enableGraph ? 'graph_reason' : 'memory_load',
      )
      .addEdge('graph_reason', 'memory_load')
      .addEdge('memory_load', 'prompt_build')
      .addEdge('prompt_build', 'llm_generate')
      .addEdge('llm_generate', END);
    return g.compile();
  }

  /** 节点包装：耗时记录 + 超时降级 + LangFuse span 埋点 */
  private wrap(
    name: string,
    fn: (state: AgentState, config: RunnableConfig) => Promise<Partial<AgentState>>,
  ) {
    return async (state: AgentState, config: RunnableConfig): Promise<Partial<AgentState>> => {
      const t0 = Date.now();
      const timeout = NODE_TIMEOUTS[name];
      this.callbacksOf(config)?.onStepStart?.(name);
      // llm_generate 使用 generation 埋点（含 token usage），不再重复建 span
      const span =
        name === 'llm_generate'
          ? null
          : this.langfuse.createSpan(this.traceOf(config), name, this.spanInput(name, state));
      try {
        const result = timeout
          ? await this.withTimeout(fn(state, config), timeout)
          : await fn(state, config);
        this.langfuse.endSpan(span, this.spanOutput(name, result));
        const latency = Date.now() - t0;
        this.callbacksOf(config)?.onStepEnd?.(name, latency, false);
        return { ...result, nodeLatencies: { [name]: latency } };
      } catch (e) {
        this.langfuse.endSpan(span, {}, e as Error);
        this.logger.warn(`node ${name} degraded: ${(e as Error).message}`);
        this.callbacksOf(config)?.onStepEnd?.(name, Date.now() - t0, true);
        return { degraded: [name], nodeLatencies: { [name]: Date.now() - t0 } };
      }
    };
  }

  private traceOf(config: RunnableConfig): TraceHandle | null {
    return (config.configurable as { trace?: TraceHandle | null })?.trace ?? null;
  }

  /** span 输入摘要：只记录对排障有用的字段，避免大 payload */
  private spanInput(name: string, state: AgentState): Record<string, unknown> {
    switch (name) {
      case 'acl_guard':
        return { userId: state.userId, workspaceId: state.workspaceId };
      case 'query_rewrite':
        return { query: state.query, windowSize: state.windowMessages.length };
      case 'complexity_router':
        return { rewrittenQuery: state.rewrittenQuery };
      case 'hybrid_retrieve':
        return { rewrittenQuery: state.rewrittenQuery, aclCount: state.aclWhitelist.length };
      case 'graph_reason':
        return { entities: state.routerEntities, relations: state.routerRelations };
      case 'memory_load':
        return { conversationId: state.conversationId };
      default:
        return {};
    }
  }

  /** span 输出摘要：召回分片 ID 落 span，支持 LangFuse 回放 */
  private spanOutput(name: string, result: Partial<AgentState>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (result.complexity) out.complexity = result.complexity;
    if (result.routerEntities) out.entities = result.routerEntities;
    if (result.rewrittenQuery) out.rewrittenQuery = result.rewrittenQuery;
    if (result.rerankedChunks) {
      out.chunks = result.rerankedChunks.map((c) => ({
        chunk_id: c.chunk_id,
        rerank_score: c.rerank_score,
        via_graph: c.via_graph ?? false,
      }));
    }
    if (result.graphTriples) out.graphTriples = result.graphTriples;
    if (result.longTermMemories) out.longTermMemories = result.longTermMemories;
    if (result.degraded) out.degraded = result.degraded;
    return out;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('node timeout')), ms)),
    ]);
  }

  private callbacksOf(config: RunnableConfig): AgentCallbacks | undefined {
    return (config.configurable as { callbacks?: AgentCallbacks })?.callbacks;
  }

  // ---------------- 节点实现 ----------------

  /** step0: 权限白名单加载（Redis 缓存，未命中回源 PG） */
  private async aclGuard(state: AgentState): Promise<Partial<AgentState>> {
    const whitelist = await this.acl.getWhitelist(state.userId);
    // 限定空间时求交；限定空间无权限则白名单为空 → 后续检索返回空
    const effective = state.workspaceId
      ? whitelist.filter((id) => id === state.workspaceId)
      : whitelist;
    return { aclWhitelist: effective };
  }

  /** 短期记忆：Redis 滑动窗口 + 滚动摘要（query_rewrite 依赖） */
  private async loadWindow(state: AgentState): Promise<Partial<AgentState>> {
    const [windowMessages, rollingSummary] = await Promise.all([
      this.memory.getWindow(state.conversationId),
      this.memory.getSummary(state.conversationId),
    ]);
    return { windowMessages, rollingSummary };
  }

  /** 查询改写：结合窗口摘要做指代消解 */
  private async queryRewrite(state: AgentState, config: RunnableConfig): Promise<Partial<AgentState>> {
    if (state.windowMessages.length === 0 && !state.rollingSummary) {
      return { rewrittenQuery: state.query };
    }
    const history = [
      state.rollingSummary ? `对话摘要：${state.rollingSummary}` : '',
      ...state.windowMessages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`),
    ]
      .filter(Boolean)
      .join('\n');

    const messages = [
      new SystemMessage(
        '你是查询改写器。结合对话历史，把用户最新问题改写为独立、完整、无指代的问题。' +
          '若原问题已完整则原样输出。只输出改写后的问题本身，不要解释。',
      ),
      new HumanMessage(`对话历史：\n${history}\n\n最新问题：${state.query}`),
    ];
    const model = this.config.get<string>('llm.routerModel');
    const generation = this.langfuse.createGeneration(this.traceOf(config), {
      name: 'query_rewrite',
      model: model ?? 'unknown',
      input: messages.map((m) => ({ role: m._getType(), content: String(m.content).slice(0, 2000) })),
    });
    const { text, usage } = await this.llm.invokeWithUsage(messages, { model, temperature: 0 });
    this.langfuse.endGeneration(generation, { output: text.slice(0, 2000), usage });
    return { rewrittenQuery: text.trim() || state.query };
  }

  /** step1: 复杂度路由 */
  private async complexityRouter(
    state: AgentState,
    config: RunnableConfig,
  ): Promise<Partial<AgentState>> {
    const messages = [
      new SystemMessage(
        '判断用户问题是否需要「多实体关联推理」。\n' +
          '- simple：单一事实查询、制度条款、定义类。例："差旅住宿标准是多少"\n' +
          '- complex：涉及 ≥2 个实体的关系/链路/对比/追溯。例："华云科技参与了哪些项目"\n' +
          '抽出问题中的实体（entities），类型仅从 PERSON/DEPARTMENT/PROJECT/COMPANY/PRODUCT/DOCUMENT 选。\n' +
          '同时判断关系类型（relations），仅从以下集合选取（不相关不要选）：\n' +
          '- BELONGS_TO：归属、隶属于\n' +
          '- MANAGES：管理\n' +
          '- PARTICIPATES_IN：参与项目\n' +
          '- RESPONSIBLE_FOR：负责\n' +
          '- DEPENDS_ON：依赖、使用供应商/产品\n' +
          '- RELATED_TO：泛关联\n' +
          '只输出 JSON：{"complexity":"simple"|"complex","entities":[{"name":"...","type":"COMPANY"}],"relations":["PARTICIPATES_IN"]}',
      ),
      new HumanMessage(state.rewrittenQuery),
    ];
    const model = this.config.get<string>('llm.routerModel');
    const generation = this.langfuse.createGeneration(this.traceOf(config), {
      name: 'complexity_router',
      model: model ?? 'unknown',
      input: messages.map((m) => ({ role: m._getType(), content: String(m.content).slice(0, 2000) })),
    });
    const { text: raw, usage } = await this.llm.invokeWithUsage(messages, { model, temperature: 0 });
    this.langfuse.endGeneration(generation, { output: raw.slice(0, 2000), usage });

    try {
      const parsed = JSON.parse(this.extractJson(raw)) as {
        complexity: Complexity;
        entities?: { name: string; type: string }[];
        relations?: string[];
      };
      this.callbacksOf(config)?.onStatus(
        'router',
        parsed.complexity === Complexity.COMPLEX ? '复杂问题，启用图谱推理' : '简单问题，混合检索',
      );
      const relations = (parsed.relations ?? []).filter((r) => typeof r === 'string' && RELATION_TYPE_SET.has(r));
      return {
        complexity: parsed.complexity === Complexity.COMPLEX ? Complexity.COMPLEX : Complexity.SIMPLE,
        routerEntities: (parsed.entities ?? []).filter((e) => typeof e?.name === 'string' && e.name.trim()),
        routerRelations: relations,
      };
    } catch {
      return { complexity: Complexity.SIMPLE, routerEntities: [], routerRelations: [] };
    }
  }

  /** step2: 多路召回 + RRF + Rerank（含 ACL 前置/结果级双重过滤） */
  private async hybridRetrieve(
    state: AgentState,
    config: RunnableConfig,
  ): Promise<Partial<AgentState>> {
    const { chunks, degraded, latencies } = await this.retrieval.retrieve(
      state.rewrittenQuery,
      state.aclWhitelist,
    );
    this.callbacksOf(config)?.onStatus('retrieval', `混合检索完成，Rerank 后 ${chunks.length} 条`);
    return { rerankedChunks: chunks, degraded, nodeLatencies: latencies };
  }

  /**
   * 图谱多跳 + 图增强补召回（仅 complex 且 enableGraph）。
   * 起点：路由实体名对齐图谱；对不上则用 Top-3 召回分片提及的实体兜底。
   */
  private async graphReason(
    state: AgentState,
    config: RunnableConfig,
  ): Promise<Partial<AgentState>> {
    const empty = { graphTriples: [] as Triple[] };
    if (state.aclWhitelist.length === 0) return empty;

    const candidates = state.routerEntities.map((e) => e.name.trim()).filter(Boolean);
    let seeds =
      candidates.length > 0 ? await this.graphDb.resolveEntityNames(candidates, state.aclWhitelist) : [];
    if (seeds.length === 0) {
      const topChunkIds = state.rerankedChunks.slice(0, 3).map((c) => c.chunk_id);
      seeds = await this.graphDb.entityNamesByChunkIds(topChunkIds, state.aclWhitelist, 3);
    }
    if (seeds.length === 0) {
      this.callbacksOf(config)?.onStatus('graph', '未在图谱中找到相关实体');
      return empty;
    }

    const maxHops = this.config.get<number>('rag.graphMaxHops') ?? 3;
    const { triples } = await this.graphDb.multiHop(
      seeds,
      maxHops,
      state.aclWhitelist,
      state.routerRelations,
    );
    this.callbacksOf(config)?.onStatus('graph', `图谱推理路径 ${triples.length} 条`);
    if (triples.length > 0) this.callbacksOf(config)?.onGraphPath(triples);

    const involved = [...new Set([...seeds, ...triples.flatMap((t) => [t[0], t[2]])])];
    const chunkIds = await this.graphDb.chunkIdsByEntityNames(involved, state.aclWhitelist, 8);
    if (chunkIds.length === 0) return { graphTriples: triples };

    const graphChunks = await this.retrieval.chunksByIds(chunkIds, state.aclWhitelist);
    const existing = new Set(state.rerankedChunks.map((c) => c.chunk_id));
    const appended = graphChunks.filter((c) => !existing.has(c.chunk_id));
    if (appended.length === 0) return { graphTriples: triples };

    const topN = this.config.get<number>('rag.rerankTopN') ?? 6;
    this.callbacksOf(config)?.onStatus('graph', `图谱补充召回 ${appended.length} 条分片`);
    return {
      graphTriples: triples,
      rerankedChunks: [...state.rerankedChunks, ...appended].slice(0, topN + 4),
    };
  }

  /** step5: 长期记忆（Mem0） */
  private async memoryLoad(state: AgentState): Promise<Partial<AgentState>> {
    const memories = await this.memory.searchLongTerm(
      state.userId,
      state.conversationId,
      state.rewrittenQuery,
    );
    return { longTermMemories: memories };
  }

  /** step6: Prompt 三段式组装（通过 state 传递给生成节点） */
  private async promptBuild(state: AgentState): Promise<Partial<AgentState>> {
    const sections: string[] = [];

    if (state.rollingSummary || state.windowMessages.length > 0) {
      const history = [
        state.rollingSummary ? `对话摘要：${state.rollingSummary}` : '',
        ...state.windowMessages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`),
      ]
        .filter(Boolean)
        .join('\n');
      sections.push(`## 对话记忆\n${history}`);
    }

    if (state.longTermMemories.length > 0) {
      sections.push(`## 用户长期记忆\n${state.longTermMemories.map((m) => `- ${m}`).join('\n')}`);
    }

    if (state.rerankedChunks.length > 0) {
      const refs = this.groupChunksByDocument(state.rerankedChunks)
        .map((g) => {
          const excerpts = g.chunks
            .map((c) => `${c.page ? `P${c.page}` : '摘录'}：${c.content}`)
            .join('\n');
          return `[${g.ref_id}] 《${g.title}》\n${excerpts}`;
        })
        .join('\n\n');
      sections.push(`## 参考资料\n${refs}`);
    }

    if (state.graphTriples.length > 0) {
      const chains = state.graphTriples.map((t) => `${t[0]} --${t[1]}--> ${t[2]}`).join('\n');
      sections.push(`## 知识图谱推理链路\n${chains}`);
    }

    // LLM 自身无时间概念，注入当前北京时间，否则「现在几点」类问题会幻觉
    const now = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'long',
    });
    const systemPrompt =
      `你是企业知识库助手。当前时间：${now}（北京时间）。规则：\n` +
      '1. 仅依据「参考资料」与「知识图谱推理链路」回答，不得编造；\n' +
      '2. 引用资料时用 [数字] 角标标注，与参考资料编号对应；同一篇文档全程只用同一个编号，不要按段落换号；\n' +
      '3. 资料不足时明确说明"根据现有资料无法确认"，并建议联系知识管理员；\n' +
      '4. 回答使用与用户相同的语言，条理清晰，复杂问题分点作答。';

    const userPrompt = `${sections.join('\n\n')}\n\n## 当前问题\n${state.rewrittenQuery}`;

    return {
      promptMessages: [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
    };
  }

  /** step7: LLM 流式生成 + 引用对齐 + generation 埋点 */
  private async llmGenerate(
    state: AgentState,
    config: RunnableConfig,
  ): Promise<Partial<AgentState>> {
    const callbacks = this.callbacksOf(config);
    const messages =
      state.promptMessages.length > 0
        ? state.promptMessages
        : [new HumanMessage(state.rewrittenQuery)];

    const generation = this.langfuse.createGeneration(this.traceOf(config), {
      name: 'llm_generate',
      model: this.config.get<string>('llm.model') ?? 'unknown',
      input: messages.map((m) => ({
        role: m._getType(),
        content: String(m.content).slice(0, 2000),
      })),
    });

    let answer = '';
    const { iterator, usage } = this.llm.streamChat(messages);
    for await (const delta of iterator) {
      answer += delta;
      callbacks?.onToken(delta);
    }
    this.langfuse.endGeneration(generation, { output: answer.slice(0, 2000), usage });

    // 引用对齐：提取 [n] 角标 → 按文档分组的 citation（一篇文档一个号）
    const groups = this.groupChunksByDocument(state.rerankedChunks);
    const citations: Citation[] = [];
    const usedRefs = new Set<number>();
    for (const match of answer.matchAll(/\[(\d+)\]/g)) {
      const refId = Number(match[1]);
      const group = groups.find((g) => g.ref_id === refId);
      if (group && !usedRefs.has(refId)) {
        usedRefs.add(refId);
        const primary = group.chunks[0];
        const citation: Citation = {
          ref_id: refId,
          chunk_id: primary.chunk_id,
          document_id: group.document_id,
          title: group.title,
          page: primary.page,
          snippet: primary.content.slice(0, 120),
          score: primary.rerank_score,
        };
        citations.push(citation);
        callbacks?.onCitation(citation);
      }
    }

    return { answer, citations, usage };
  }

  /** 按文档首次出现顺序编号，供 Prompt 与引用对齐共用 */
  private groupChunksByDocument(chunks: ChunkHit[]): Array<{
    ref_id: number;
    document_id: string;
    title: string;
    chunks: ChunkHit[];
  }> {
    const groups: Array<{
      ref_id: number;
      document_id: string;
      title: string;
      chunks: ChunkHit[];
    }> = [];
    const indexByDoc = new Map<string, number>();
    for (const chunk of chunks) {
      const existing = indexByDoc.get(chunk.document_id);
      if (existing != null) {
        groups[existing].chunks.push(chunk);
        continue;
      }
      indexByDoc.set(chunk.document_id, groups.length);
      groups.push({
        ref_id: groups.length + 1,
        document_id: chunk.document_id,
        title: chunk.title,
        chunks: [chunk],
      });
    }
    return groups;
  }

  private extractJson(raw: string): string {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? match[0] : raw;
  }
}
