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

/** 文档入库状态机 */
export enum DocumentStatus {
  UPLOADED = 'UPLOADED',
  PARSING = 'PARSING',
  CHUNKING = 'CHUNKING',
  INDEXING = 'INDEXING',
  GRAPHING = 'GRAPHING',
  READY = 'READY',
  FAILED = 'FAILED',
}

/** 入库任务阶段 */
export enum IngestionStage {
  PARSE = 'parse',
  CHUNK = 'chunk',
  INDEX = 'index',
  GRAPH = 'graph',
}

export enum JobStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  DONE = 'done',
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
