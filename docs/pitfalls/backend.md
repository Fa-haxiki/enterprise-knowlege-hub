# NestJS 后端坑点

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
