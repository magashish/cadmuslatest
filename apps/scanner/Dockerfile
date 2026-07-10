# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y ffmpeg poppler-utils python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy workspace config first (layer cache)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Copy all package.json files so pnpm can resolve the workspace
COPY apps/scanner/package.json apps/scanner/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY apps/scanner/ apps/scanner/
COPY packages/db/ packages/db/
COPY packages/shared/ packages/shared/

# Build the scanner and its workspace dependencies
RUN pnpm --filter @cadmus/db build && pnpm --filter @cadmus/scanner build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y ffmpeg poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/scanner/package.json apps/scanner/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json

# Install production deps only
RUN pnpm install --frozen-lockfile --prod

# Copy built output from builder
COPY --from=builder /app/apps/scanner/dist/ apps/scanner/dist/
COPY --from=builder /app/packages/db/dist/ packages/db/dist/

# Run as non-root
RUN addgroup --system cadmus && adduser --system --ingroup cadmus cadmus
USER cadmus

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "apps/scanner/dist/index.js"]
