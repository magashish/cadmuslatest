#!/usr/bin/env bash
set -euo pipefail

# Deploy all apps to the dev environment.
# Wraps the individual deploy scripts with dev-specific env vars.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export API_SERVICE_NAME="cadmus-api-dev"
export WEB_SERVICE_NAME="cadmus-web-dev"
export MEDIA_BUCKET="${GCP_PROJECT:-cadmus-84}-media-dev"
export ADMIN_BUCKET="${GCP_PROJECT:-cadmus-84}-admin-dev"
export BASE_DOMAIN="dev.cadmus.digital"
export VITE_API_URL="https://api.dev.cadmus.digital"
export DB_SECRET_NAME="DATABASE_URL_DEV"
export JWT_SECRET_NAME="JWT_SECRET_DEV"

TARGET="${1:-all}"

case "$TARGET" in
  api)
    "$SCRIPT_DIR/deploy-api.sh"
    ;;
  admin)
    "$SCRIPT_DIR/deploy-admin.sh"
    ;;
  web)
    "$SCRIPT_DIR/deploy-web.sh"
    ;;
  all)
    echo "=== Deploying all to dev ==="
    "$SCRIPT_DIR/deploy-api.sh"
    "$SCRIPT_DIR/deploy-admin.sh"
    "$SCRIPT_DIR/deploy-web.sh"
    ;;
  *)
    echo "Usage: $0 [api|admin|web|all]"
    exit 1
    ;;
esac
