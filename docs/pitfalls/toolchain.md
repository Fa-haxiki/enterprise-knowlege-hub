# 工具链与构建坑点

## 脚本内 nohup 后台进程被托管终端连带清理

- **现象**：`dev-up.sh` 用 `(nohup node ... &)` 启动的服务，日志显示启动成功，但脚本退出后进程全部消失，端口无监听
- **根因**：IDE 托管终端在命令结束后按进程组清理子进程树；`nohup`/`disown` 只防 SIGHUP，挡不住进程组级 SIGKILL
- **修复**：`scripts/spawn-daemon.py` 用 `fork + setsid` 让服务脱离终端会话，PID 写入 `.pids/`；macOS 无 setsid 命令，需 Python 实现
- **相关**：`scripts/dev-up.sh`、`scripts/spawn-daemon.py`

## pnpm install 失败：私有 registry 不可达

- **现象**：`GET http://npm.kf315.net/@pnpm%2Fexe: fetch failed`，install 直接失败
- **根因**：用户全局 `.npmrc` 指向不可达的私有 registry；且根 `package.json` 的 `packageManager` 字段会让 pnpm 在读取项目级配置**之前**先尝试下载自身
- **修复**：项目级 `.npmrc` 写 `registry=https://registry.npmjs.org/`；删除根 `package.json` 的 `packageManager` 字段
- **相关**：`.npmrc`、`package.json`

## pnpm v11+ 原生模块构建被静默忽略

- **现象**：`ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: argon2, esbuild, msgpackr-extract`，运行时原生模块缺失
- **根因**：pnpm v11 起 `onlyBuiltDependencies` 需迁移到 `pnpm-workspace.yaml` 的 `allowBuilds`
- **修复**：在 `pnpm-workspace.yaml` 配置 `allowBuilds`（显式允许 argon2/esbuild/@nestjs/core/msgpackr-extract，显式拒绝 @scarf/scarf 避免 verify-deps 失败）
- **相关**：`pnpm-workspace.yaml`

## monorepo 下 NestJS webpack 打包后 @ekh/* 无法加载

- **现象**：`ERR_MODULE_NOT_FOUND: @ekh/shared`；或原生模块（msgpackr-extract）被打包进 bundle 报错
- **根因**：默认 externals 把 pnpm 软链的 workspace 包也外部化了，Node 无法直接执行其指向 `.ts` 的 `main`
- **修复**：自定义 `webpack.config.js`，函数式 externals——`@ekh/*` 一律打包进 bundle，其余 `node_modules` 外部化；`nest-cli.json` 开启 `webpack: true` 并指定 `webpackConfigPath`
- **相关**：`apps/api/webpack.config.js`、`apps/worker/webpack.config.js`、`apps/*/nest-cli.json`

## NestJS DTO/实体大量 TS2564 未初始化报错

- **现象**：`TS2564: Property has no initializer`，装饰器类成片报错
- **根因**：`strictPropertyInitialization` 与装饰器注入模式冲突
- **修复**：`tsconfig.base.json` 设 `"strictPropertyInitialization": false`（NestJS 项目通行做法）
- **相关**：`tsconfig.base.json`

## dev-up.sh 跑的是 dist 产物，改代码不 rebuild 不生效

- **现象**：改完 API/Worker 源码后 `dev-up.sh` 重启，行为完全没变，新实体表也没建
- **根因**：`dev-up.sh` 用 `node dist/main.js` 启动，仅在 dist 缺失时才自动 build；源码变更后必须手动 `pnpm -r --filter @ekh/api --filter @ekh/worker build`
- **修复**：改代码后先 build 再 `dev-down && dev-up`；排查"改了不生效"先确认 dist 时间戳
- **相关**：`scripts/dev-up.sh`

## seed 脚本 data-source.ts 的 .env 路径少一级导致 auth_failed

- **现象**：`pnpm seed:admin` 报 `password authentication failed`，但 API 服务连接正常
- **根因**：`data-source.ts` 用 `__dirname + '../../../.env'`，从 `src/database` 出发只解析到 `apps/.env`（不存在），PG_PASSWORD 落空；API 的 ConfigModule 用的是 `process.cwd() + '../../.env'` 指向仓库根
- **修复**：改为 `'../../../../.env'`（src/database 与 dist/database 到仓库根均为四级）
- **相关**：`apps/api/src/database/data-source.ts`
