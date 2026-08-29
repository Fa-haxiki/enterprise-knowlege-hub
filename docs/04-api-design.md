# 04 API 设计规范

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | `/api/v1` |
| 认证 | `Authorization: Bearer <access_token>`（JWT，2h 有效，Refresh Token 7d） |
|  Content-Type | `application/json`（文件上传除外） |
| 分页 | `?page=1&page_size=20`，响应含 `total` |
| 时间 | ISO 8601 UTC |
| 限流 | 问答 20 次/分/用户，其余 120 次/分/用户，超限返回 `429` |

### 统一响应包

```json
// 成功
{ "code": 0, "data": { }, "request_id": "req_01J..." }
// 失败
{ "code": 40103, "message": "无该知识空间访问权限", "request_id": "req_01J..." }
```

### 错误码段位

| 段位 | 含义 | 示例 |
| --- | --- | --- |
| 400xx | 参数/状态错误 | 40001 参数校验失败；40009 文档状态不允许操作 |
| 401xx | 认证/权限 | 40101 Token 过期；40103 无空间权限 |
| 404xx | 资源不存在 | 40401 文档不存在 |
| 409xx | 冲突 | 40901 邮箱已注册 |
| 429xx | 限流 | 42901 触发限流 |
| 500xx | 服务端 | 50001 内部错误；50201 LLM 网关不可用；50202 MinerU 不可用 |

## 2. 端点总览

| 模块 | 方法 & 路径 | 说明 |
| --- | --- | --- |
| 认证 | POST `/auth/register` · POST `/auth/login` · POST `/auth/refresh` · POST `/auth/logout` | 双 Token |
| 用户 | GET `/users/me` · PATCH `/users/me` | |
| 空间 | GET/POST `/workspaces` · GET/PATCH/DELETE `/workspaces/{id}` | |
| 空间成员 | GET/POST `/workspaces/{id}/members` · PATCH/DELETE `/workspaces/{id}/members/{userId}` | 授权即失效其 Redis 白名单 |
| 文档 | POST `/workspaces/{id}/documents/upload-init` · POST `/documents/{id}/upload-complete` · GET `/documents` · GET `/documents/{id}` · DELETE `/documents/{id}` · POST `/documents/{id}/reindex` · GET `/documents/{id}/progress` | 分片上传 + 状态机 |
| 对话 | GET/POST `/conversations` · PATCH/DELETE `/conversations/{id}` · GET `/conversations/{id}/messages` | |
| 问答 | POST `/chat/completions`（**SSE**） | 核心接口，见 §4 |
| 反馈 | POST `/messages/{id}/feedback` | 赞/踩 |
| TTS | `wss://.../tts/stream`（**WebSocket**） | 见 §5 |
| 管理 | GET `/audit-logs` · GET `/admin/stats` | 审计/看板 |

## 3. 关键接口示例

### 3.1 登录

```http
POST /api/v1/auth/login
{ "email": "zhang@corp.com", "password": "***" }

200
{
  "code": 0,
  "data": {
    "access_token": "eyJhb...",
    "refresh_token": "d8f2...",
    "expires_in": 7200,
    "user": { "id": "u_01", "name": "张三", "role": "member" }
  }
}
```

### 3.2 分片上传（三步）

```http
# 1) 初始化：申请预签名分片上传地址
POST /api/v1/workspaces/{wsId}/documents/upload-init
{ "filename": "差旅制度.pdf", "file_size": 83886080, "mime_type": "application/pdf" }
→ { "document_id": "d_01", "upload_id": "...", "part_urls": ["https://minio/...1", "..."] }

# 2) 前端直传 MinIO（PUT part_urls，不经过 API 服务）

# 3) 合并并触发入库管线
POST /api/v1/documents/d_01/upload-complete
{ "upload_id": "...", "etags": ["..."] }
→ { "document_id": "d_01", "status": "PARSING" }
```

### 3.3 入库进度

```http
GET /api/v1/documents/d_01/progress
→ { "status": "INDEXING", "stage": "index", "percent": 72, "error_msg": null }
```

## 4. 问答接口（SSE，核心）

```http
POST /api/v1/chat/completions
Authorization: Bearer ...
Accept: text/event-stream

{
  "conversation_id": "c_01",        // 可选，缺省创建新对话
  "workspace_id": "w_01",           // 可选，限定检索空间；缺省检索全部有权限空间
  "query": "A项目的供应商还服务了哪些项目？",
  "options": {
    "enable_graph": true,           // 允许复杂路由触发图谱（默认 true）
    "enable_tts": false,            // 语音（默认 false）
    "model": "deepseek-chat"        // 可选覆盖默认模型
  }
}
```

### SSE 事件序列

```
event: meta
data: {"conversation_id":"c_01","message_id":"m_88","complexity":"complex","trace_id":"lf_abc"}

event: status
data: {"stage":"retrieval","detail":"混合检索完成，召回 40 条，Rerank 后 6 条"}

event: status
data: {"stage":"graph","detail":"识别实体 2 个，图谱推理路径 5 条"}

event: token
data: {"delta":"A 项目的供应商为"}

event: token
data: {"delta":"华云科技[1]，其同时服务了"}

event: citation
data: {"ref_id":1,"chunk_id":"ck_201","document_id":"d_01","title":"供应商名录.pdf","page":3,"snippet":"华云科技…服务项目清单…"}

event: graph_path
data: {"triples":[["A项目","USES_SUPPLIER","华云科技"],["华云科技","SERVES","B项目"],["B项目","OWNED_BY","李四"]]}

event: usage
data: {"prompt_tokens":3210,"completion_tokens":486,"latency_ms":4120,"node_latencies":{"retrieval":310,"rerank":205,"graph":890,"llm_first_token":1180}}

event: done
data: {"message_id":"m_88"}
```

| 事件 | 说明 |
| --- | --- |
| `meta` | 首帧，返回路由结果与 LangFuse trace_id |
| `status` | 阶段进度（可多次），前端展示「正在检索/正在图谱推理…」 |
| `token` | 增量文本，前端追加渲染 |
| `citation` | 引用分片，与正文中 `[ref_id]` 角标对应 |
| `graph_path` | 图谱推理链路（仅 complex 路径） |
| `usage` | Token 与各节点耗时 |
| `error` | `{"code":50201,"message":"LLM 网关不可用"}`，随后关闭流 |
| `done` | 正常结束 |

## 5. TTS WebSocket 协议

```
连接: wss://host/ws/tts?token=<access_token>

# 客户端 → 服务端（与 SSE 问答并行建立）
→ {"action":"start","message_id":"m_88","voice":"zh-CN-Xiaoxiao","speed":1.0}

# 服务端 → 客户端
← {"type":"audio_chunk","seq":1,"format":"mp3","data":"<base64>","text_range":[0,24]}
← {"type":"audio_chunk","seq":2,...}
← {"type":"end","total_chunks":12}
# 或
← {"type":"error","code":50203,"message":"TTS 服务不可用"}
```

- 服务端从 SSE 文字流按句切分送 TTS，合成一片推一片，前端边收边播
- `text_range` 用于前端「朗读高亮」跟随

## 6. 其余接口摘要

```http
# 空间授权（Owner）
POST /api/v1/workspaces/w_01/members
{ "user_id": "u_02", "role": "viewer" }

# 答案反馈
POST /api/v1/messages/m_88/feedback
{ "feedback": 1, "comment": "引用准确" }

# 对话历史
GET /api/v1/conversations/c_01/messages?page=1&page_size=50
→ { "code":0, "data":{ "total":12, "items":[ {"id":"m_88","role":"assistant","content":"...","citations":[...],"feedback":1} ] } }
```

## 7. 幂等与并发

- `upload-init` / `upload-complete` 以 `upload_id` 幂等
- 问答接口不幂等，但前端需防重复提交（生成中禁用发送）
- 文档删除为软删除 + 异步清理（MinIO 文件、chunk、ES 文档、Neo4j Chunk 节点）
