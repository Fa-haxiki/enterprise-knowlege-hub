# NestJS 后端坑点

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
