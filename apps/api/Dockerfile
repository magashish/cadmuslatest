# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy workspace config first (layer cache)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Copy all package.json files so pnpm can resolve the workspace
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/cloud/package.json packages/cloud/package.json
COPY packages/shared/package.json packages/shared/package.json

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/api/ apps/api/
COPY packages/db/ packages/db/
COPY packages/ai/ packages/ai/
COPY packages/cloud/ packages/cloud/
COPY packages/shared/ packages/shared/

# Build the API and its workspace dependencies
RUN pnpm turbo build --filter=@cadmus/api...

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/cloud/package.json packages/cloud/package.json
COPY packages/shared/package.json packages/shared/package.json

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# Copy built output from builder
COPY --from=builder /app/apps/api/dist/ apps/api/dist/
COPY --from=builder /app/packages/db/dist/ packages/db/dist/
COPY --from=builder /app/packages/ai/dist/ packages/ai/dist/
COPY --from=builder /app/packages/cloud/dist/ packages/cloud/dist/
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/

# Run as non-root
RUN addgroup --system cadmus && adduser --system --ingroup cadmus cadmus
USER cadmus

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "apps/api/dist/index.js"]
