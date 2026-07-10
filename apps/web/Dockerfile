# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

ARG PUBLIC_API_URL
ARG PUBLIC_SITE_URL

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy workspace config first (layer cache)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./

# Copy package.json files for workspace resolution
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY apps/web/ apps/web/
COPY packages/shared/ packages/shared/

# Build with env vars available at build time
ENV PUBLIC_API_URL=${PUBLIC_API_URL}
ENV PUBLIC_SITE_URL=${PUBLIC_SITE_URL}
RUN pnpm turbo build --filter=@cadmus/web...

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN pnpm install --frozen-lockfile --prod

# Copy built output
COPY --from=builder /app/apps/web/dist/ apps/web/dist/
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/

# Run as non-root
RUN addgroup --system cadmus && adduser --system --ingroup cadmus cadmus
USER cadmus

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["node", "apps/web/dist/server/entry.mjs"]
