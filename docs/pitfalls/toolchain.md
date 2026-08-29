# 工具链与构建坑点

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
