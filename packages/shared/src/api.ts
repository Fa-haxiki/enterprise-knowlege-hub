/** 统一响应包 */
export interface ApiResponse<T = unknown> {
  code: number;
  data?: T;
  message?: string;
  request_id: string;
}

/** 分页响应 */
export interface Paginated<T> {
  total: number;
  page: number;
  page_size: number;
  items: T[];
}

/** 错误码 */
export const ErrorCode = {
  PARAM_INVALID: 40001,
  PARAM_MISSING: 40002,
  DOC_STATUS_INVALID: 40009,

  TOKEN_EXPIRED: 40101,
  TOKEN_INVALID: 40102,
  ACL_FORBIDDEN: 40103,
  CREDENTIAL_INVALID: 40104,
  ACCOUNT_LOCKED: 40105,

  NOT_FOUND: 40401,

  CONFLICT: 40901,

  RATE_LIMITED: 42901,

  INTERNAL: 50001,
  LLM_UNAVAILABLE: 50201,
  MINERU_UNAVAILABLE: 50202,
  TTS_UNAVAILABLE: 50203,
  ES_UNAVAILABLE: 50204,
  NEO4J_UNAVAILABLE: 50205,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
