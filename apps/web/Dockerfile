FROM node:24-alpine AS builder
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src
COPY apps/web/package.json apps/web/
COPY apps/web/index.html apps/web/vite.config.ts apps/web/tsconfig.json apps/web/
COPY apps/web/tailwind.config.js apps/web/postcss.config.js apps/web/
COPY apps/web/src apps/web/src
RUN pnpm install --frozen-lockfile --filter @ekh/web...
RUN pnpm --filter @ekh/web build

FROM nginx:1.27-alpine
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
