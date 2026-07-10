#!/usr/bin/env bash
set -euo pipefail

# ── Load config ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$REPO_ROOT/.env" ]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${GCP_REGION:=us-central1}"
: "${CLOUD_SQL_INSTANCE:=cadmus}"

CLOUD_SQL_CONNECTION="${GCP_PROJECT}:${GCP_REGION}:${CLOUD_SQL_INSTANCE}"
PROXY_PORT=5433  # avoid conflict with local Postgres on 5432

echo "╔══════════════════════════════════════╗"
echo "║  Cadmus — Production DB Migration    ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Connection: $CLOUD_SQL_CONNECTION"
echo ""

# ── Fetch DB credentials from Secret Manager ────────────────────────────────
echo "→ Fetching DATABASE_URL from Secret Manager..."
SECRET_DB_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL)

# Rewrite the unix socket URL to a TCP URL via the proxy
# Original: postgresql://user:pass@localhost/db?host=/cloudsql/...
# Rewritten: postgresql://user:pass@127.0.0.1:5433/db
DB_USER=$(echo "$SECRET_DB_URL" | sed -n 's|postgresql://\([^:]*\):.*|\1|p')
DB_PASS=$(echo "$SECRET_DB_URL" | sed -n 's|postgresql://[^:]*:\([^@]*\)@.*|\1|p')
DB_NAME=$(echo "$SECRET_DB_URL" | sed -n 's|.*@[^/]*/\([^?]*\).*|\1|p')
PROXY_DB_URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:${PROXY_PORT}/${DB_NAME}"

# ── Start Cloud SQL Auth Proxy ──────────────────────────────────────────────
echo "→ Starting Cloud SQL Auth Proxy..."
cloud-sql-proxy "$CLOUD_SQL_CONNECTION" \
  --port="$PROXY_PORT" \
  --quiet &
PROXY_PID=$!

cleanup() {
  echo "→ Stopping Cloud SQL Auth Proxy (PID $PROXY_PID)..."
  kill "$PROXY_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for proxy to be ready
echo "→ Waiting for proxy to be ready..."
for i in $(seq 1 15); do
  if (echo > /dev/tcp/127.0.0.1/"$PROXY_PORT") 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "ERROR: Cloud SQL Auth Proxy failed to start."
    echo "Make sure cloud-sql-proxy is installed and you're authenticated with gcloud."
    exit 1
  fi
  sleep 1
done
echo "→ Proxy ready."

# ── Run migrations ──────────────────────────────────────────────────────────
echo "→ Running Drizzle migrations..."
cd "$REPO_ROOT"
DATABASE_URL="$PROXY_DB_URL" pnpm db:migrate:run

echo ""
echo "════════════════════════════════════════"
echo "  Migrations applied successfully!"
echo "════════════════════════════════════════"
