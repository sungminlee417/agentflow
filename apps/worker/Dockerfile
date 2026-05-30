FROM node:20-slim

RUN npm install -g pnpm@9.12.0

WORKDIR /app

# Copy workspace root manifests first for layer caching
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json ./

# Copy package manifests so install can resolve workspace graph
COPY apps/worker/package.json ./apps/worker/
COPY packages/core/package.json ./packages/core/
COPY packages/domain-youtube/package.json ./packages/domain-youtube/

RUN pnpm install --frozen-lockfile

# Copy sources
COPY packages ./packages
COPY apps/worker ./apps/worker

WORKDIR /app/apps/worker
CMD ["pnpm", "start"]
