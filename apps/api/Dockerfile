# 生产镜像：pnpm workspace 构建 → pnpm deploy 裁剪生产依赖
FROM node:24-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY apps/api/package.json apps/api/
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/nest-cli.json apps/api/webpack.config.js apps/api/
COPY apps/api/src apps/api/src
RUN pnpm install --frozen-lockfile --filter @ekh/api...
RUN pnpm --filter @ekh/shared build 2>/dev/null || true
RUN pnpm --filter @ekh/api build
RUN pnpm deploy --legacy --filter @ekh/api --prod /prod/api

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /prod/api/node_modules ./node_modules
COPY --from=builder /repo/apps/api/dist ./dist
EXPOSE 8080
CMD ["node", "dist/main.js"]
