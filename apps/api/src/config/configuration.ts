export default () => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.API_PORT ?? '8080', 10),
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    // 全局限流：次/分/IP（压测时调大）
    throttleLimit: parseInt(process.env.THROTTLE_LIMIT ?? '120', 10),
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    accessTtlSeconds: 2 * 3600,
    refreshTtlSeconds: 7 * 24 * 3600,
  },
  database: {
    url:
      process.env.DATABASE_URL ??
      `postgresql://${process.env.PG_USER ?? 'postgres'}:${process.env.PG_PASSWORD}@${process.env.PG_HOST ?? 'localhost'}:${process.env.PG_PORT ?? '5432'}/${process.env.PG_DB ?? 'ekh'}`,
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },
  es: {
    node: process.env.ES_NODE ?? 'http://localhost:9200',
    index: process.env.ES_INDEX ?? 'kb_chunks',
  },
  neo4j: {
    uri: process.env.NEO4J_URI ?? 'bolt://localhost:7687',
    user: process.env.NEO4J_USER ?? 'neo4j',
    password: process.env.NEO4J_PASSWORD ?? 'neo4j',
  },
  minio: {
    endPoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: parseInt(process.env.MINIO_PORT ?? '9000', 10),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_USER ?? 'ekh',
    secretKey: process.env.MINIO_PASSWORD ?? '',
    bucket: process.env.MINIO_BUCKET ?? 'ekh-docs',
  },
  llm: {
    baseURL: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'deepseek-chat',
    routerModel: process.env.LLM_ROUTER_MODEL ?? process.env.LLM_MODEL ?? 'deepseek-chat',
  },
  embedding: {
    baseURL: process.env.EMBEDDING_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.EMBEDDING_API_KEY ?? '',
    model: process.env.EMBEDDING_MODEL ?? 'qwen3.7-text-embedding',
    dim: parseInt(process.env.EMBEDDING_DIM ?? '1024', 10),
  },
  reranker: {
    url: process.env.RERANKER_URL ?? 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks',
    apiKey: process.env.RERANKER_API_KEY ?? process.env.EMBEDDING_API_KEY ?? '',
    model: process.env.RERANKER_MODEL ?? 'qwen3-rerank',
  },
  mineru: {
    url: process.env.MINERU_URL ?? 'https://mineru.net',
    token: process.env.MINERU_TOKEN ?? '',
    model: process.env.MINERU_MODEL ?? 'vlm',
  },
  mem0: {
    url: process.env.MEM0_URL ?? 'http://localhost:8888',
    apiKey: process.env.MEM0_API_KEY ?? '',
  },
  langfuse: {
    enabled: process.env.LANGFUSE_ENABLED === 'true',
    host: process.env.LANGFUSE_HOST ?? 'http://localhost:3100',
    publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
    secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
  },
  rag: {
    chunkSize: parseInt(process.env.CHUNK_SIZE ?? '512', 10),
    chunkOverlap: parseInt(process.env.CHUNK_OVERLAP ?? '64', 10),
    retrieveTopK: parseInt(process.env.RETRIEVE_TOP_K ?? '20', 10),
    rerankTopN: parseInt(process.env.RERANK_TOP_N ?? '6', 10),
    rerankMinScore: parseFloat(process.env.RERANK_MIN_SCORE ?? '0.35'),
    rrfK: parseInt(process.env.RRF_K ?? '60', 10),
    graphMaxHops: parseInt(process.env.GRAPH_MAX_HOPS ?? '3', 10),
    aclCacheTtlSeconds: parseInt(process.env.ACL_CACHE_TTL_SECONDS ?? '600', 10),
    chatRateLimitPerMin: parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN ?? '20', 10),
  },
  security: {
    // Prompt 注入检测：命中后拒绝进入 LLM 链路
    injectionBlockEnabled: process.env.PROMPT_INJECTION_BLOCK !== 'false',
    // 发往 LLM 的内容脱敏（身份证/银行卡/手机号等高敏信息）
    llmMaskEnabled: process.env.LLM_MASK_SENSITIVE !== 'false',
  },
  tts: {
    serviceUrl: process.env.TTS_SERVICE_URL ?? 'http://localhost:8750',
  },
});
