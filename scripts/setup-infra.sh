#!/usr/bin/env bash
set -euo pipefail

# ── Load config ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a; source "$SCRIPT_DIR/../.env"; set +a
fi

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${GCP_REGION:=us-central1}"
: "${CLOUD_SQL_INSTANCE:=cadmus}"
: "${ADMIN_BUCKET:=${GCP_PROJECT}-admin}"
: "${MEDIA_BUCKET:=${GCP_PROJECT}-media}"
: "${STAGING_BUCKET:=${GCP_PROJECT}-media-staging}"
# Browser origins allowed to PUT directly to the staging bucket (resumable
# uploads). Override PLATFORM_DOMAIN for a different environment.
: "${PLATFORM_DOMAIN:=cadmus.digital}"

# Dedicated least-privilege runtime service accounts. Cloud Run services run as
# these (never the default compute SA, which is left with no roles).
API_SA="cadmus-api@${GCP_PROJECT}.iam.gserviceaccount.com"
WEB_SA="cadmus-web@${GCP_PROJECT}.iam.gserviceaccount.com"
SCANNER_SA="cadmus-scanner@${GCP_PROJECT}.iam.gserviceaccount.com"
# CI deployer (created out of band with Workload Identity Federation); granted
# actAs on the runtime SAs below so it can deploy services that run as them.
DEPLOY_SA="github-deploy@${GCP_PROJECT}.iam.gserviceaccount.com"

DB_NAME="cadmus"
DB_USER="cadmus"
DB_PASS=$(openssl rand -base64 24)
JWT_SECRET=$(openssl rand -base64 32)

echo "╔══════════════════════════════════════╗"
echo "║  Cadmus — GCP Infrastructure Setup ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Project:  $GCP_PROJECT"
echo "Region:   $GCP_REGION"
echo "Instance: $CLOUD_SQL_INSTANCE"
echo ""

gcloud config set project "$GCP_PROJECT"

# ── Enable APIs ──────────────────────────────────────────────────────────────
echo "→ Enabling GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  aiplatform.googleapis.com \
  cloudtasks.googleapis.com

# ── Cloud SQL ────────────────────────────────────────────────────────────────
echo "→ Creating Cloud SQL instance (this takes a few minutes)..."
gcloud sql instances create "$CLOUD_SQL_INSTANCE" \
  --database-version=POSTGRES_16 \
  --edition=enterprise \
  --tier=db-f1-micro \
  --region="$GCP_REGION" \
  --storage-auto-increase \
  --assign-ip || echo "  (instance may already exist)"

echo "→ Creating database and user..."
gcloud sql databases create "$DB_NAME" \
  --instance="$CLOUD_SQL_INSTANCE" || echo "  (database may already exist)"

gcloud sql users create "$DB_USER" \
  --instance="$CLOUD_SQL_INSTANCE" \
  --password="$DB_PASS" || echo "  (user may already exist)"

# ── GCS Buckets ──────────────────────────────────────────────────────────────
echo "→ Creating GCS buckets..."
gcloud storage buckets create "gs://${MEDIA_BUCKET}" \
  --location="$GCP_REGION" \
  --uniform-bucket-level-access || echo "  (bucket may already exist)"

gcloud storage buckets create "gs://${ADMIN_BUCKET}" \
  --location="$GCP_REGION" \
  --uniform-bucket-level-access || echo "  (bucket may already exist)"

# Make admin bucket publicly readable for static hosting
echo "→ Configuring admin bucket for static hosting..."
gcloud storage buckets add-iam-policy-binding "gs://${ADMIN_BUCKET}" \
  --member=allUsers \
  --role=roles/storage.objectViewer

# Set main page and 404 page for SPA routing
gcloud storage buckets update "gs://${ADMIN_BUCKET}" \
  --web-main-page-suffix=index.html \
  --web-error-page=index.html

# Staging bucket: holds uploaded media until it passes moderation. Private —
# objects are streamed/copied out by the runtime SAs, never served directly.
echo "→ Creating staging bucket (private)..."
gcloud storage buckets create "gs://${STAGING_BUCKET}" \
  --location="$GCP_REGION" \
  --uniform-bucket-level-access || echo "  (bucket may already exist)"

# Never allow public access to staging (pre-moderation content).
gcloud storage buckets update "gs://${STAGING_BUCKET}" --public-access-prevention

# Allow the admin/dashboard origins to PUT directly to staging (resumable
# uploads bypass the ~32MB Cloud Run request cap). Content-Range is required
# for the single-shot resumable PUT.
echo "→ Applying staging bucket CORS..."
CORS_FILE="$(mktemp)"
cat > "$CORS_FILE" <<JSON
[
  {
    "origin": ["https://${PLATFORM_DOMAIN}", "https://www.${PLATFORM_DOMAIN}", "https://app.${PLATFORM_DOMAIN}"],
    "method": ["PUT"],
    "responseHeader": ["Content-Type", "Content-Range"],
    "maxAgeSeconds": 3600
  }
]
JSON
gcloud storage buckets update "gs://${STAGING_BUCKET}" --cors-file="$CORS_FILE"
rm -f "$CORS_FILE"

# ── Artifact Registry ────────────────────────────────────────────────────────
echo "→ Creating Artifact Registry Docker repo..."
gcloud artifacts repositories create cadmus \
  --repository-format=docker \
  --location="$GCP_REGION" \
  --description="Cadmus container images" || echo "  (repo may already exist)"

# ── Secret Manager ───────────────────────────────────────────────────────────
CLOUD_SQL_CONNECTION="${GCP_PROJECT}:${GCP_REGION}:${CLOUD_SQL_INSTANCE}"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost/${DB_NAME}"

echo "→ Creating secrets..."
echo -n "$DATABASE_URL" | gcloud secrets create DATABASE_URL --data-file=- || \
  echo -n "$DATABASE_URL" | gcloud secrets versions add DATABASE_URL --data-file=-

echo -n "$JWT_SECRET" | gcloud secrets create JWT_SECRET --data-file=- || \
  echo -n "$JWT_SECRET" | gcloud secrets versions add JWT_SECRET --data-file=-

echo -n "REPLACE_ME" | gcloud secrets create ANTHROPIC_API_KEY --data-file=- || true
echo -n "REPLACE_ME" | gcloud secrets create GEMINI_API_KEY --data-file=- || true
echo -n "REPLACE_ME" | gcloud secrets create STITCH_API_KEY --data-file=- || true

# ── IAM ──────────────────────────────────────────────────────────────────────
# Cloud Run services run as dedicated least-privilege SAs, NOT the default
# compute SA (which is intentionally left with no roles, so any service that
# forgets --service-account fails closed instead of inheriting Editor).

echo "→ Creating dedicated runtime service accounts..."
gcloud iam service-accounts create cadmus-api \
  --display-name="Cadmus API (Cloud Run runtime)" || echo "  (cadmus-api may already exist)"
gcloud iam service-accounts create cadmus-web \
  --display-name="Cadmus Web (Cloud Run runtime)" || echo "  (cadmus-web may already exist)"
gcloud iam service-accounts create cadmus-scanner \
  --display-name="Cadmus Scanner (Cloud Run runtime)" || echo "  (cadmus-scanner may already exist)"

echo "→ Granting project-level roles to the API SA..."
for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor \
            roles/aiplatform.user roles/cloudtasks.enqueuer roles/run.invoker \
            roles/logging.viewer; do
  gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:${API_SA}" --role="$ROLE" --condition=None --quiet
done

echo "→ Granting project-level roles to the Scanner SA..."
gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
  --member="serviceAccount:${SCANNER_SA}" --role=roles/cloudsql.client --condition=None --quiet

# Bucket access. objectAdmin = read/write objects; legacyBucketReader adds
# storage.buckets.get, which the API health check needs (bucket.exists()) and
# objectAdmin does NOT include.
echo "→ Granting bucket access to runtime SAs..."
for BUCKET in "$MEDIA_BUCKET" "$STAGING_BUCKET"; do
  for MEMBER in "$API_SA" "$SCANNER_SA"; do
    gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
      --member="serviceAccount:${MEMBER}" --role=roles/storage.objectAdmin
  done
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${API_SA}" --role=roles/storage.legacyBucketReader
done

# The API mints Cloud Tasks jobs that invoke the scanner with an OIDC token for
# the scanner SA — it must be able to actAs the scanner SA.
echo "→ Granting actAs / impersonation bindings..."
gcloud iam service-accounts add-iam-policy-binding "$SCANNER_SA" \
  --member="serviceAccount:${API_SA}" --role=roles/iam.serviceAccountUser --quiet

# tokenCreator on itself lets the API mint keyless V4 signed URLs (signBlob).
# Current code streams/uploads without signing, so this is only needed if signed
# URLs are reintroduced — kept for parity with the running environment.
gcloud iam service-accounts add-iam-policy-binding "$API_SA" \
  --member="serviceAccount:${API_SA}" --role=roles/iam.serviceAccountTokenCreator --quiet

# CI (github-deploy) deploys services that run as these SAs, so it needs actAs.
for TARGET in "$API_SA" "$WEB_SA" "$SCANNER_SA"; do
  gcloud iam service-accounts add-iam-policy-binding "$TARGET" \
    --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser --quiet || \
    echo "  (skipped — ${DEPLOY_SA} may not exist yet)"
done

# The web SA only reads its own Sentry DSN secret (guarded — secret may not
# exist yet at first bootstrap).
gcloud secrets add-iam-policy-binding SENTRY_DSN_WEB \
  --member="serviceAccount:${WEB_SA}" --role=roles/secretmanager.secretAccessor --quiet || \
  echo "  (skipped — create SENTRY_DSN_WEB secret, then re-run)"

# NOTE: the scanner's run.invoker binding on the cadmus-scanner *service* is
# applied by the deploy workflow (the service must exist first).

echo ""
echo "════════════════════════════════════════"
echo "  Infrastructure created!"
echo ""
echo "  Cloud SQL: $CLOUD_SQL_CONNECTION"
echo "  DB Password: $DB_PASS"
echo "  JWT Secret: $JWT_SECRET"
echo ""
echo "  Next steps:"
echo "  1. Set real API keys in Secret Manager:"
echo "     gcloud secrets versions add ANTHROPIC_API_KEY --data-file=-"
echo "     gcloud secrets versions add GEMINI_API_KEY --data-file=-"
echo "     gcloud secrets versions add STITCH_API_KEY --data-file=-"
echo "  2. Run DB migrations: ./scripts/db-migrate-prod.sh"
echo "  3. Deploy: ./scripts/deploy-api.sh"
echo "════════════════════════════════════════"
