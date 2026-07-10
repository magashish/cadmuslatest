#!/usr/bin/env bash
set -euo pipefail

# ── Load config ──────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a; source "$SCRIPT_DIR/../.env"; set +a
fi

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${GCP_REGION:=us-central1}"

CLOUD_RUN_SERVICE="cadmus-web"
ORIGIN_DOMAIN="origin.cadmus.digital"

echo "╔══════════════════════════════════════════╗"
echo "║  Cadmus — Load Balancer Setup            ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Project:  $GCP_PROJECT"
echo "Region:   $GCP_REGION"
echo "Service:  $CLOUD_RUN_SERVICE"
echo "Origin:   $ORIGIN_DOMAIN"
echo ""

gcloud config set project "$GCP_PROJECT"

# ── 1. Reserve a global static IP ───────────────────────────────────────────
echo "→ Reserving global static IP..."
gcloud compute addresses create cadmus-web-lb-ip \
  --global \
  --ip-version=IPV4 || echo "  (may already exist)"

LB_IP=$(gcloud compute addresses describe cadmus-web-lb-ip \
  --global --format='value(address)')
echo "  Static IP: $LB_IP"

# ── 2. Create serverless NEG pointing to Cloud Run ──────────────────────────
echo "→ Creating serverless NEG..."
gcloud compute network-endpoint-groups create cadmus-web-neg \
  --region="$GCP_REGION" \
  --network-endpoint-type=serverless \
  --cloud-run-service="$CLOUD_RUN_SERVICE" || echo "  (may already exist)"

# ── 3. Create backend service ────────────────────────────────────────────────
echo "→ Creating backend service..."
gcloud compute backend-services create cadmus-web-backend \
  --global \
  --load-balancing-scheme=EXTERNAL_MANAGED || echo "  (may already exist)"

echo "→ Adding NEG to backend service..."
gcloud compute backend-services add-backend cadmus-web-backend \
  --global \
  --network-endpoint-group=cadmus-web-neg \
  --network-endpoint-group-region="$GCP_REGION" || echo "  (may already exist)"

# ── 4. Create URL map ───────────────────────────────────────────────────────
echo "→ Creating URL map..."
gcloud compute url-maps create cadmus-web-urlmap \
  --default-service=cadmus-web-backend \
  --global || echo "  (may already exist)"

# ── 5. Create Google-managed SSL certificate ────────────────────────────────
echo "→ Creating Google-managed SSL certificate for $ORIGIN_DOMAIN..."
gcloud compute ssl-certificates create cadmus-origin-cert \
  --domains="$ORIGIN_DOMAIN" \
  --global || echo "  (may already exist)"

# ── 6. Create HTTPS target proxy ────────────────────────────────────────────
echo "→ Creating HTTPS target proxy..."
gcloud compute target-https-proxies create cadmus-web-https-proxy \
  --ssl-certificates=cadmus-origin-cert \
  --url-map=cadmus-web-urlmap \
  --global || echo "  (may already exist)"

# ── 7. Create forwarding rule ───────────────────────────────────────────────
echo "→ Creating forwarding rule..."
gcloud compute forwarding-rules create cadmus-web-fwd-rule \
  --global \
  --load-balancing-scheme=EXTERNAL_MANAGED \
  --target-https-proxy=cadmus-web-https-proxy \
  --address=cadmus-web-lb-ip \
  --ports=443 || echo "  (may already exist)"

echo ""
echo "════════════════════════════════════════════"
echo "  Load balancer created!"
echo ""
echo "  Static IP: $LB_IP"
echo ""
echo "  Next steps (manual Cloudflare config):"
echo "  1. Add A record: origin.cadmus.digital → $LB_IP (proxied)"
echo "  2. Set CF for SaaS fallback origin → origin.cadmus.digital"
echo "  3. Set SSL mode → Full (Strict)"
echo "  4. Wait for Google-managed cert provisioning (~10-60 min)"
echo "════════════════════════════════════════════"
