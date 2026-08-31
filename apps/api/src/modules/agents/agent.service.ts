import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { END, START, StateGraph } from '@langchain/langgraph';
import type { RunnableConfig } from '@langchain/core/runnables';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Complexity, type Citation, type Triple } from '@ekh/shared';
import { AclService } from '../workspaces/acl.service';
import { RetrievalService } from '../retrieval/retrieval.service';
import { MemoryService } from '../memory/memory.service';
import { GraphService } from '../graph/graph.service';
import { LlmService } from '../llm/llm.service';
import { LangfuseService, type TraceHandle } from '../observability/langfuse.service';
import { AgentStateAnnotation, type AgentCallbacks, type AgentState } from './agent.state';

const NODE_TIMEOUTS: Record<string, number> = {
  query_rewrite: 5_000,
  complexity_router: 5_000,
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
    private readonly graphDb: GraphService,
    private readonly llm: LlmService,
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

  private buildGraph() {
    const g = new StateGraph(AgentStateAnnotation)
      .addNode('acl_guard', this.wrap('acl_guard', this.aclGuard.bind(this)))
      .addNode('load_window', this.wrap('load_window', this.loadWindow.bind(this)))
      .addNode('query_rewrite', this.wrap('query_rewrite', this.queryRewrite.bind(this)))
      .addNode('complexity_router', this.wrap('complexity_router', this.complexityRouter.bind(this)))
      .addNode('hybrid_retrieve', this.wrap('hybrid_retrieve', this.hybridRetrieve.bind(this)))
      .addNode('graph_reason', this.wrap('graph_reason', this.graphReason.bind(this)))
      .addNode('memory_load', this.wrap('memory_load', this.memoryLoad.bind(this)))
      .addNode('prompt_build', this.wrap('prompt_build', this.promptBuild.bind(this)))
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
        return { entities: state.routerEntities };
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
          '- complex：涉及 ≥2 个实体的关系/链路/对比/追溯。例："A项目的供应商还服务了哪些项目"\n' +
          '只输出 JSON：{"complexity":"simple"|"complex","entities":[{"name":"...","type":"Project|Supplier|Person|Policy|Department"}]}',
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
      };
      this.callbacksOf(config)?.onStatus(
        'router',
        parsed.complexity === Complexity.COMPLEX ? '复杂问题，启用图谱推理' : '简单问题，混合检索',
      );
      return {
        complexity: parsed.complexity === Complexity.COMPLEX ? Complexity.COMPLEX : Complexity.SIMPLE,
        routerEntities: parsed.entities ?? [],
      };
    } catch {
      return { complexity: Complexity.SIMPLE, routerEntities: [] };
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

  /** step3+4: 图谱多跳推理 + 图增强检索（仅 complex 路径） */
  private async graphReason(
    state: AgentState,
    config: RunnableConfig,
  ): Promise<Partial<AgentState>> {
    if (state.routerEntities.length === 0) return { graphTriples: [] };

    const aligned = await this.graphDb.alignEntities(
      state.routerEntities as { name: string; type: 'Project' | 'Supplier' | 'Person' | 'Policy' | 'Department' }[],
    );
    if (aligned.length === 0) return { graphTriples: [] };

    const maxHops = this.config.get<number>('rag.graphMaxHops') ?? 3;
    const triples = await this.graphDb.multiHop(aligned, maxHops);
    this.callbacksOf(config)?.onStatus('graph', `图谱推理路径 ${triples.length} 条`);
    if (triples.length > 0) this.callbacksOf(config)?.onGraphPath(triples);

    // 图增强检索：推理链路涉及的实体反查 MENTIONS 分片，合并进候选（去重，上限 topN+4）
    const entityNames = [
      ...new Set([...aligned.map((e) => e.name), ...triples.flatMap((t) => [t[0], t[2]])]),
    ];
    const chunkIds = await this.graphDb.chunksByEntities(entityNames, state.aclWhitelist, 8);
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
      const refs = state.rerankedChunks
        .map((c, i) => `[${i + 1}] 《${c.title}》${c.page ? `P${c.page}` : ''}：${c.content}`)
        .join('\n');
      sections.push(`## 参考资料\n${refs}`);
    }

    if (state.graphTriples.length > 0) {
      const chains = state.graphTriples.map((t) => `${t[0]} --${t[1]}--> ${t[2]}`).join('\n');
      sections.push(`## 知识图谱推理链路\n${chains}`);
    }

    const systemPrompt =
      '你是企业知识库助手。规则：\n' +
      '1. 仅依据「参考资料」与「知识图谱推理链路」回答，不得编造；\n' +
      '2. 引用资料时用 [数字] 角标标注，与参考资料编号对应；\n' +
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

    // 引用对齐：提取 [n] 角标 → citation
    const citations: Citation[] = [];
    const usedRefs = new Set<number>();
    for (const match of answer.matchAll(/\[(\d+)\]/g)) {
      const refId = Number(match[1]);
      const chunk = state.rerankedChunks[refId - 1];
      if (chunk && !usedRefs.has(refId)) {
        usedRefs.add(refId);
        const citation: Citation = {
          ref_id: refId,
          chunk_id: chunk.chunk_id,
          document_id: chunk.document_id,
          title: chunk.title,
          page: chunk.page,
          snippet: chunk.content.slice(0, 120),
          score: chunk.rerank_score,
        };
        citations.push(citation);
        callbacks?.onCitation(citation);
      }
    }

    return { answer, citations, usage };
  }

  private extractJson(raw: string): string {
    const match = raw.match(/\{[\s\S]*\}/);
    return match ? match[0] : raw;
  }
}
