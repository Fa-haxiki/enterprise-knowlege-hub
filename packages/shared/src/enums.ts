/** 空间成员角色 */
export enum WorkspaceRole {
  OWNER = 'owner',
  EDITOR = 'editor',
  VIEWER = 'viewer',
}

/** 系统级角色 */
export enum SystemRole {
  SYSADMIN = 'sysadmin',
  MEMBER = 'member',
}

/** 账号审核状态（注册申请制） */
export enum UserStatus {
  /** 注册已提交，等待管理员审核 */
  PENDING = 'PENDING',
  /** 审核通过，可登录系统 */
  ACTIVE = 'ACTIVE',
  /** 审核拒绝，无法登录 */
  REJECTED = 'REJECTED',
}

/**
 * 文档入库状态机。
 * 主路径：UPLOADED → PENDING_REVIEW → PARSING → CHUNKING → INDEXING → GRAPHING → READY
 * 审核拒绝 → REJECTED；任一入库阶段异常 → FAILED。
 */
export enum DocumentStatus {
  /** 记录已创建，分片上传尚未完成 */
  UPLOADED = 'UPLOADED',
  /** 上传完成，等待部门审核员审核 */
  PENDING_REVIEW = 'PENDING_REVIEW',
  /** 审核未通过，不进入解析 */
  REJECTED = 'REJECTED',
  /** MinerU 解析文档结构 */
  PARSING = 'PARSING',
  /** 按语义切分文本块 */
  CHUNKING = 'CHUNKING',
  /** Embedding + PGVector/ES 双写索引 */
  INDEXING = 'INDEXING',
  /** 实体抽取并写入 Neo4j 图谱（失败不阻断 READY） */
  GRAPHING = 'GRAPHING',
  /** 入库完成，可被检索 */
  READY = 'READY',
  /** 入库失败，可重试 */
  FAILED = 'FAILED',
}

/** 入库任务阶段（与 DocumentStatus 处理中的阶段一一对应） */
export enum IngestionStage {
  /** 文档解析（MinerU） */
  PARSE = 'parse',
  /** 语义分块 */
  CHUNK = 'chunk',
  /** 向量化与双写索引 */
  INDEX = 'index',
  /** 知识图谱构建 */
  GRAPH = 'graph',
}

/** 入库任务（ingestion job）执行状态 */
export enum JobStatus {
  /** 已入队，等待 worker 领取 */
  PENDING = 'pending',
  /** worker 正在执行 */
  RUNNING = 'running',
  /** 该阶段成功结束 */
  DONE = 'done',
  /** 该阶段失败（图谱失败不阻断文档 READY） */
  FAILED = 'failed',
}

/** 消息角色 */
export enum MessageRole {
  USER = 'user',
  ASSISTANT = 'assistant',
  SYSTEM = 'system',
}

/** 问题复杂度（LangGraph 路由结果） */
export enum Complexity {
  SIMPLE = 'simple',
  COMPLEX = 'complex',
}
