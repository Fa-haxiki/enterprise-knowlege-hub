FROM node:24-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
# worker 依赖 @ekh/api 的实体/配置/服务源码（webpack 内联打包）
COPY apps/api/package.json apps/api/
COPY apps/api/tsconfig.json apps/api/
COPY apps/api/src apps/api/src
COPY apps/worker/package.json apps/worker/
COPY apps/worker/tsconfig.json apps/worker/tsconfig.build.json apps/worker/nest-cli.json apps/worker/webpack.config.js apps/worker/
COPY apps/worker/src apps/worker/src
RUN pnpm install --frozen-lockfile --filter @ekh/worker...
RUN pnpm --filter @ekh/shared build 2>/dev/null || true
RUN pnpm --filter @ekh/worker build
RUN pnpm deploy --legacy --filter @ekh/worker --prod /prod/worker

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /prod/worker/node_modules ./node_modules
COPY --from=builder /repo/apps/worker/dist ./dist
CMD ["node", "dist/main.js"]
