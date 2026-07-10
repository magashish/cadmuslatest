#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a; source "$SCRIPT_DIR/../.env"; set +a
fi

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${GCP_REGION:=us-central1}"
: "${CLOUD_SQL_INSTANCE:=cadmus}"
: "${API_SERVICE_NAME:=cadmus-api}"
: "${MEDIA_BUCKET:=${GCP_PROJECT}-media}"
: "${DB_SECRET_NAME:=DATABASE_URL}"
: "${JWT_SECRET_NAME:=JWT_SECRET}"

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/cadmus/${API_SERVICE_NAME}"
CLOUD_SQL_CONNECTION="${GCP_PROJECT}:${GCP_REGION}:${CLOUD_SQL_INSTANCE}"

echo "→ Building API image (linux/amd64)..."
echo "  Service: $API_SERVICE_NAME"
docker build --platform linux/amd64 -f apps/api/Dockerfile -t "$IMAGE" .

echo "→ Pushing to Artifact Registry..."
docker push "$IMAGE"

SECRETS="DATABASE_URL=${DB_SECRET_NAME}:latest,JWT_SECRET=${JWT_SECRET_NAME}:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,CLOUDFLARE_API_TOKEN=CLOUDFLARE_API_TOKEN:latest,CLOUDFLARE_ZONE_ID=CLOUDFLARE_ZONE_ID:latest"

# Optional secrets — only include if they exist in Secret Manager
if gcloud secrets describe STITCH_API_KEY --quiet 2>/dev/null; then
  SECRETS="${SECRETS},STITCH_API_KEY=STITCH_API_KEY:latest"
fi

echo "→ Deploying to Cloud Run..."
gcloud run deploy "$API_SERVICE_NAME" \
  --image="$IMAGE" \
  --region="$GCP_REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --add-cloudsql-instances="$CLOUD_SQL_CONNECTION" \
  --set-secrets="$SECRETS" \
  --set-env-vars="GCS_BUCKET=${MEDIA_BUCKET},NODE_ENV=production,CLOUD_SQL_CONNECTION=${CLOUD_SQL_CONNECTION},BASE_DOMAIN=${BASE_DOMAIN:-cadmus.digital}" \
  --memory=512Mi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=10 \
  --port=8080

API_URL=$(gcloud run services describe "$API_SERVICE_NAME" --region="$GCP_REGION" --format='value(status.url)')
echo ""
echo "API deployed: $API_URL"
echo "Health check: curl $API_URL/api/health"
