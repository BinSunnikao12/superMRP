# =====================================================================
# APS MRP 多阶段构建 Dockerfile
# - 基础镜像：node:20-bookworm-slim（glibc + 工具链）
# - Thin mode 不需要 instantclient
# - 最终镜像只保留 node_modules / dist
# =====================================================================

# -------- Stage 1: deps --------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# 关键：libaio / libnsl 兼容某些 oracledb binary
RUN apt-get update -y && apt-get install -y --no-install-recommends \
        libaio1 libnsl3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# -------- Stage 2: build --------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build

# -------- Stage 3: runtime --------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 健康检查：直接退出 0（容器即跑一次任务）
RUN apt-get update -y && apt-get install -y --no-install-recommends \
        libaio1 libnsl3 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# 默认入口：跑一次 APS MRP 然后退出（批处理模式）
ENTRYPOINT ["node", "dist/main.js"]
