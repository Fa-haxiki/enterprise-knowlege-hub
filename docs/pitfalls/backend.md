# NestJS 后端坑点

## 部门成员与空间成员两套模型未打通，部门员工看不到部门空间

- **现象**：财务部普通员工（department_members 有记录）空间列表为空、问答「根据现有资料无法确认」；空间列表修复后问答仍不命中
- **根因**：① ACL 只认 workspace_members，部门成员身份不参与空间授权；② 问答走 `getWhitelist`（Redis 缓存 600s），列表接口走 DB 直查——代码升级后旧缓存不失效，出现「列表可见但检索白名单仍是旧的」
- **修复**：`AclService.getWhitelist/getRole` 打通部门成员 → 部门空间默认 viewer；`listMine` 合并部门空间；部门成员/管理员增删、空间改挂部门时主动 `invalidate`；**部署权限模型变更后需清 `acl:whitelist:*` 缓存**
- **相关**：`apps/api/src/modules/workspaces/acl.service.ts`、`workspaces.service.ts` listMine/update、`departments.service.ts`、`admin.service.ts`

## AG-UI 客户端发送完整 RunAgentInput，DTO 白名单 400

- **现象**：`POST /agui/chat` 400 `property tools should not exist; property context should not exist; property forwardedProps should not exist`
- **根因**：标准 AG-UI 客户端（如 @ag-ui/client HttpAgent）会携带完整 RunAgentInput 字段（tools/context/forwardedProps），全局 ValidationPipe 开了 `forbidNonWhitelisted`，DTO 未声明的字段直接拒绝
- **修复**：DTO 声明这三个可选字段（宽松类型，可不使用）；对接标准协议时 DTO 要覆盖协议全量字段，而非只声明用到的子集
- **相关**：`apps/api/src/modules/chat/agui.controller.ts` AguiRunDto

## PATCH 接口的可空字段校验绕过：`if (value)` 挡不住显式传 null

- **现象**：空间 update 接口传 `{"department_id": null}` 可绕过「必须挂部门」校验，把空间改成无部门，导致部门管理员看不到该空间的待审文档
- **根因**：校验写成 `if (department_id && ...)`，显式传 `null` 时跳过校验；而落库判断是 `!== undefined`，null 被写入
- **修复**：对「必填但可 PATCH 的字段」显式拒绝 null：`if (department_id === null) throw ...`；历史脏数据用 SQL 补挂部门
- **教训**：可空字段的 PATCH 校验要用 `=== null` / `!== undefined` 区分「未传」与「显式置空」，不能依赖真值判断
- **相关**：`apps/api/src/modules/workspaces/workspaces.service.ts` update

## MinerU 线上 API：单文件解析接口不支持直接上传文件

- **现象**：`POST /api/v4/extract/task` 只接受 `url` 参数，multipart 上传无效；本地 MinIO 的 localhost 地址云端又不可达
- **根因**：线上 API 设计为「URL 拉取」或「签名上传」两种模式，无 multipart 直传
- **修复**：本地文件走 `POST /api/v4/file-urls/batch` 申请 OSS 签名链接（单文件也可，files 数组传 1 个）→ PUT 上传（不要设 Content-Type）→ 自动提交解析 → 轮询 `GET /api/v4/extract-results/batch/{batch_id}` → 下载 `full_zip_url`
- **相关**：`apps/worker/src/pipelines/mineru.client.ts`

## MinerU 线上结果是 zip 包，需映射 content_list.json 而非结构化 blocks

- **现象**：线上 API 不返回结构化 JSON，只有 zip（full.md + `*_content_list.json` + layout.json + 图片）
- **修复**：用 `fflate` 解压，取 `*_content_list.json`（注意排除 `_content_list_v2.json`）；类型映射：`text`+`text_level`→heading、`text`→paragraph、`table`→table（`table_body` 是 HTML）、`equation`→formula、`image/chart`→figure；`header/footer/page_number/page_footnote/ref_text` 是页眉页脚噪声直接丢弃（比本地服务更干净）；`page_idx` 是 0 起始需 +1
- **相关**：`apps/worker/src/pipelines/mineru.client.ts` fetchAndMap

## 百炼 compatible-api 与 compatible-mode 是两套不同路径

- **现象**：rerank 请求打到 `compatible-mode/v1/reranks` 会 404；embedding 打到 `compatible-api` 同理
- **根因**：DashScope 的 OpenAI 兼容入口分两个：embedding/batch/chat 走 `https://dashscope.aliyuncs.com/compatible-mode/v1`，rerank 走 `https://dashscope.aliyuncs.com/compatible-api/v1/reranks`，路径不通用
- **修复**：`.env` 中 `EMBEDDING_BASE_URL` 与 `RERANKER_URL` 分别配置，reranker 配置完整 URL（非 baseURL 拼接）
- **相关**：`apps/api/src/modules/llm/reranker.service.ts`、`apps/api/src/config/configuration.ts`

## 百炼 Embedding Batch API 是异步任务，需轮询且防 BullMQ stalled

- **现象**：入库 embedding 改 Batch API 后，job 处理时间从秒级变分钟级，BullMQ 报 stalled 并重复执行 job（重复提交 batch）
- **根因**：Batch 流程为 上传 jsonl（POST /files, purpose=batch）→ 创建任务（POST /batches, endpoint=/v1/embeddings）→ 轮询 GET /batches/{id} → 下载 GET /files/{output_file_id}/content；轮询期间超过 BullMQ 默认 lockDuration(30s) 锁过期
- **修复**：轮询循环内每 15s `job.extendLock(token, 60_000)` 续锁（process 需声明第二个参数接收 token）；20 分钟超时抛错走重试（重建场景幂等：先清后写）
- **相关**：`apps/worker/src/processors/ingestion.processor.ts` embedViaBatch、`apps/api/src/modules/llm/embedding.service.ts`

## 百炼同步 embeddings 单批上限 20 条

- **现象**：qwen3.7-text-embedding 同步接口 input 数组超过 20 条直接报错
- **修复**：`EmbeddingService.embed` 按 20 条分批串行合并；响应按 `data[].index` 归位（不保证顺序），并校验返回维度与 `EMBEDDING_DIM` 一致
- **相关**：`apps/api/src/modules/llm/embedding.service.ts` SYNC_BATCH_LIMIT

## 百炼 403 AllocationQuota.FreeTierOnly 是额度问题非协议错误

- **现象**：rerank/embedding 返回 403 `{"code":"AllocationQuota.FreeTierOnly","message":"Free quota exhausted..."}`
- **根因**：账号开了「仅使用免费额度」模式且该模型 100 万 token 免费额度已用完；请求本身（鉴权/模型名/body）已被正常受理
- **修复**：百炼控制台关闭「仅免费额度」模式或充值；检索链路对 rerank 失败有降级（按 RRF 取 Top-N），不阻断问答
- **相关**：`apps/api/src/modules/retrieval/retrieval.service.ts`（reranker degraded 日志）

## @nestjs/websockets 必须与大版本对齐

- **现象**：API 启动崩溃 `ERR_MODULE_NOT_FOUND: @nestjs/common/internal`
- **根因**：`pnpm add @nestjs/websockets` 默认装最新 v12，但项目 NestJS 是 v10，v12 依赖 v11+ 的内部路径
- **修复**：显式指定 `pnpm add @nestjs/websockets@^10 @nestjs/platform-socket.io@^10`
- **教训**：NestJS 生态包（websockets/platform-*/throttler 等）必须与 @nestjs/core 大版本一致，安装时先看 @nestjs/core 版本
- **相关**：`apps/api/package.json`

## Neo4j Cypher：WITH 引用未在作用域的变量

- **现象**：入库建图阶段降级 `Variable 'c' not defined`，文档 READY 但图谱无数据
- **根因**：`MERGE (n:Type {...}) WITH c, n MERGE (c)-[:MENTIONS]->(n)` —— `c` 是上一个独立 `session.run` 的变量，Cypher 变量不跨语句传递
- **修复**：同一语句内先 `MATCH (c:Chunk {chunk_id: $chunkId})` 再 MERGE 实体与关系
- **教训**：图谱写入失败只记 WARN（degraded 不阻断入库），排查时先看 worker 日志而非文档状态
- **相关**：`apps/api/src/modules/graph/graph.service.ts` upsertGraph

## ConfigModule 找不到 monorepo 根目录的 .env

- **现象**：TypeORM 报 `password authentication failed`，实际是环境变量为空
- **根因**：`.env` 在 monorepo 根，进程 cwd 是 `apps/api`，默认只找 cwd 下 `.env`
- **修复**：`ConfigModule.forRoot` 的 `envFilePath` 配多路径：`[path.resolve(process.cwd(), '../../.env'), path.resolve(process.cwd(), '.env')]`
- **相关**：`apps/api/src/app.module.ts`、`apps/worker/src/worker.module.ts`

## Worker 不要 import 整个 API 业务模块

- **现象**：Worker 启动报 `Cannot find module 'uuid'` / `@nestjs/throttler` 缺失
- **根因**：`worker.module.ts` import 了 API 的 `DocumentsModule`，把控制器、守卫等传递依赖全拉进来
- **修复**：只直接 import 需要的纯服务（如 `StorageService`），缺什么依赖在 worker 自己的 `package.json` 补
- **相关**：`apps/worker/src/worker.module.ts`

## 自定义 Guard 依赖 req.user 时必须与 JwtAuthGuard 同挂

- **现象**：AdminController 只挂 `@UseGuards(AdminGuard)`，所有请求 403（req.user 为 undefined）
- **根因**：AdminGuard 读 `req.user.role`，但 req.user 由 JwtAuthGuard 填充；单独挂 AdminGuard 时它先于认证执行
- **修复**：`@UseGuards(JwtAuthGuard, AdminGuard)` 按顺序同挂
- **相关**：`apps/api/src/modules/admin/admin.controller.ts`、`common/guards/admin.guard.ts`

## worker.module 显式 entities 数组：实体新增关系时需同步补关联实体

- **现象**：worker 启动报 `Entity metadata for WorkspaceEntity#department was not found`，反复重连
- **根因**：worker 的 TypeORM 用显式 `entities: [...]`（autoLoadEntities: false），WorkspaceEntity 新增 `department` 关系后，DepartmentEntity 未加入 worker 的 entities
- **修复**：worker.module.ts 的 entities 数组补上 DepartmentEntity；同理 @Global 的 SecurityModule 也需在 worker.module imports 一次全局模块才在 worker 上下文生效
- **相关**：`apps/worker/src/worker.module.ts`

## 新建模块挂 JwtAuthGuard 报 Nest can't resolve dependencies（缺 AuthModule）

- **现象**：新建 SearchController 挂 `@UseGuards(JwtAuthGuard)` 后 API 启动崩溃：`Nest can't resolve dependencies of the JwtAuthGuard (?, ConfigService, Reflector)`
- **根因**：JwtAuthGuard 构造依赖 JwtService，而 JwtService 由 AuthModule 提供并导出；新模块只 imports 了 WorkspacesModule（拿 AclService），没 imports AuthModule
- **修复**：新模块 imports 数组补上 `AuthModule`（`apps/api/src/modules/retrieval/retrieval.module.ts`）；凡是用到 JwtAuthGuard 的模块都必须直接/间接导入 AuthModule
- **相关**：`apps/api/src/modules/retrieval/retrieval.module.ts`、`auth/auth.module.ts`
