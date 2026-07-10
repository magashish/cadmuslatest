#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$REPO_ROOT/.env" ]; then
  set -a; source "$REPO_ROOT/.env"; set +a
fi

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${GCP_REGION:=us-central1}"
: "${ADMIN_BUCKET:=${GCP_PROJECT}-admin}"
: "${VITE_API_URL:=https://api.cadmus.digital}"

echo "→ Building admin SPA..."
echo "  API URL: $VITE_API_URL"
cd "$REPO_ROOT"
rm -rf apps/admin/dist
VITE_API_URL="$VITE_API_URL" pnpm --filter @cadmus/shared build
VITE_API_URL="$VITE_API_URL" pnpm --filter @cadmus/admin build

echo "→ Uploading assets (long-lived cache)..."
gcloud storage rsync apps/admin/dist/assets "gs://${ADMIN_BUCKET}/assets" \
  --recursive \
  --delete-unmatched-destination-objects \
  --cache-control="public, max-age=31536000, immutable"

echo "→ Uploading index.html + other files (no cache)..."
for f in apps/admin/dist/*; do
  [ -d "$f" ] && continue
  gcloud storage cp "$f" "gs://${ADMIN_BUCKET}/$(basename "$f")" \
    --cache-control="no-store, no-cache, must-revalidate, max-age=0"
done

echo ""
echo "Admin deployed: https://cadmus.digital/admin"
