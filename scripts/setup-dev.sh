#!/usr/bin/env bash
set -euo pipefail

# ── Setup dev environment resources in the same GCP project ──────────────────
# Uses the existing Cloud SQL instance with a separate database,
# separate GCS buckets, separate Cloud Run services, and separate secrets.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a; source "$SCRIPT_DIR/../.env"; set +a
fi

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${GCP_REGION:=us-central1}"
: "${CLOUD_SQL_INSTANCE:=cadmus}"

DEV_DB_NAME="cadmus_dev"
DEV_DB_USER="cadmus_dev"
DEV_DB_PASS=$(openssl rand -base64 24)
DEV_JWT_SECRET=$(openssl rand -base64 32)
DEV_MEDIA_BUCKET="${GCP_PROJECT}-media-dev"
DEV_ADMIN_BUCKET="${GCP_PROJECT}-admin-dev"

echo "╔══════════════════════════════════════╗"
echo "║  Cadmus — Dev Environment Setup      ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Project:  $GCP_PROJECT"
echo "Region:   $GCP_REGION"
echo "Instance: $CLOUD_SQL_INSTANCE (shared with prod)"
echo "Database: $DEV_DB_NAME"
echo ""

gcloud config set project "$GCP_PROJECT"

# ── Database (same Cloud SQL instance, separate DB + user) ───────────────────
echo "→ Creating dev database and user..."
gcloud sql databases create "$DEV_DB_NAME" \
  --instance="$CLOUD_SQL_INSTANCE" || echo "  (database may already exist)"

gcloud sql users create "$DEV_DB_USER" \
  --instance="$CLOUD_SQL_INSTANCE" \
  --password="$DEV_DB_PASS" || echo "  (user may already exist)"

# ── GCS Buckets ──────────────────────────────────────────────────────────────
echo "→ Creating dev GCS buckets..."
gcloud storage buckets create "gs://${DEV_MEDIA_BUCKET}" \
  --location="$GCP_REGION" \
  --uniform-bucket-level-access || echo "  (bucket may already exist)"

gcloud storage buckets create "gs://${DEV_ADMIN_BUCKET}" \
  --location="$GCP_REGION" \
  --uniform-bucket-level-access || echo "  (bucket may already exist)"

# Make admin bucket publicly readable for static hosting
gcloud storage buckets add-iam-policy-binding "gs://${DEV_ADMIN_BUCKET}" \
  --member=allUsers \
  --role=roles/storage.objectViewer

gcloud storage buckets update "gs://${DEV_ADMIN_BUCKET}" \
  --web-main-page-suffix=index.html \
  --web-error-page=index.html

# ── Secrets ──────────────────────────────────────────────────────────────────
CLOUD_SQL_CONNECTION="${GCP_PROJECT}:${GCP_REGION}:${CLOUD_SQL_INSTANCE}"
DATABASE_URL_DEV="postgresql://${DEV_DB_USER}:${DEV_DB_PASS}@localhost/${DEV_DB_NAME}?host=/cloudsql/${CLOUD_SQL_CONNECTION}"

echo "→ Creating dev secrets..."
echo -n "$DATABASE_URL_DEV" | gcloud secrets create DATABASE_URL_DEV --data-file=- 2>/dev/null || \
  echo -n "$DATABASE_URL_DEV" | gcloud secrets versions add DATABASE_URL_DEV --data-file=-

echo -n "$DEV_JWT_SECRET" | gcloud secrets create JWT_SECRET_DEV --data-file=- 2>/dev/null || \
  echo -n "$DEV_JWT_SECRET" | gcloud secrets versions add JWT_SECRET_DEV --data-file=-

# ── IAM — grant Cloud Run SA access to dev buckets ───────────────────────────
PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT" --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "→ Granting dev bucket permissions..."
gcloud storage buckets add-iam-policy-binding "gs://${DEV_MEDIA_BUCKET}" \
  --member="serviceAccount:${SA}" \
  --role=roles/storage.objectAdmin

echo ""
echo "════════════════════════════════════════"
echo "  Dev environment created!"
echo ""
echo "  Database:     $DEV_DB_NAME (on $CLOUD_SQL_INSTANCE)"
echo "  DB Password:  $DEV_DB_PASS"
echo "  JWT Secret:   $DEV_JWT_SECRET"
echo "  Media Bucket: $DEV_MEDIA_BUCKET"
echo "  Admin Bucket: $DEV_ADMIN_BUCKET"
echo ""
echo "  Cloud Run services will be created on first deploy:"
echo "    cadmus-api-dev, cadmus-web-dev"
echo ""
echo "  Next: push to the 'dev' branch to trigger a deploy."
echo "════════════════════════════════════════"
