#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a; source "$SCRIPT_DIR/../.env"; set +a
fi

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${GCP_REGION:=us-central1}"
: "${WEB_SERVICE_NAME:=cadmus-web}"

# Auto-detect API URL from Cloud Run unless explicitly set to a non-localhost value
if [ -z "${PUBLIC_API_URL:-}" ] || echo "$PUBLIC_API_URL" | grep -q "localhost"; then
  API_SERVICE_NAME="${API_SERVICE_NAME:-cadmus-api}"
  PUBLIC_API_URL="https://api.${BASE_DOMAIN:-cadmus.digital}"
  echo "→ Using API URL: $PUBLIC_API_URL"
fi

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/cadmus/${WEB_SERVICE_NAME}"

echo "→ Building Web image (linux/amd64)..."
docker build --platform linux/amd64 -f apps/web/Dockerfile \
  --build-arg PUBLIC_API_URL="$PUBLIC_API_URL" \
  --build-arg PUBLIC_SITE_URL="${PUBLIC_SITE_URL:-}" \
  -t "$IMAGE" .

echo "→ Pushing to Artifact Registry..."
docker push "$IMAGE"

echo "→ Deploying to Cloud Run..."
gcloud run deploy "$WEB_SERVICE_NAME" \
  --image="$IMAGE" \
  --region="$GCP_REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,BASE_DOMAIN=${BASE_DOMAIN:-cadmus.digital},PUBLIC_API_URL=${PUBLIC_API_URL}" \
  --memory=256Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=10 \
  --port=8080

WEB_URL=$(gcloud run services describe "$WEB_SERVICE_NAME" --region="$GCP_REGION" --format='value(status.url)')
echo ""
echo "Web deployed: $WEB_URL"
echo "Health check: curl $WEB_URL/health"
