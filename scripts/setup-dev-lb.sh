#!/usr/bin/env bash
set -euo pipefail

# ── Dev Load Balancer Setup ─────────────────────────────────────────────────
# Creates a GCP HTTPS LB fronting cadmus-api-dev, cadmus-web-dev, and the
# admin SPA bucket, with host-based routing. Uses a Cloudflare origin
# certificate for SSL so the zone can stay on Full (Strict).
#
# After running this script:
# 1. Generate a Cloudflare Origin Certificate covering *.dev.cadmus.digital
# 2. Upload it as the SSL cert (instructions printed at end)
# 3. Add DNS records in Cloudflare

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a; source "$SCRIPT_DIR/../.env"; set +a
fi

: "${GCP_PROJECT:?Set GCP_PROJECT}"
: "${GCP_REGION:=us-central1}"

ADMIN_BUCKET="${GCP_PROJECT}-admin-dev"

echo "╔══════════════════════════════════════════╗"
echo "║  Cadmus — Dev Load Balancer Setup        ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Project:       $GCP_PROJECT"
echo "Region:        $GCP_REGION"
echo "Admin bucket:  $ADMIN_BUCKET"
echo ""

gcloud config set project "$GCP_PROJECT"

# ── 1. Reserve a global static IP ───────────────────────────────────────────
echo "→ Reserving global static IP..."
gcloud compute addresses create cadmus-dev-lb-ip \
  --global \
  --ip-version=IPV4 2>/dev/null || echo "  (already exists)"

LB_IP=$(gcloud compute addresses describe cadmus-dev-lb-ip \
  --global --format='value(address)')
echo "  Static IP: $LB_IP"

# ── 2. Create serverless NEGs for Cloud Run services ────────────────────────
echo "→ Creating serverless NEG for cadmus-api-dev..."
gcloud compute network-endpoint-groups create cadmus-api-dev-neg \
  --region="$GCP_REGION" \
  --network-endpoint-type=serverless \
  --cloud-run-service=cadmus-api-dev 2>/dev/null || echo "  (already exists)"

echo "→ Creating serverless NEG for cadmus-web-dev..."
gcloud compute network-endpoint-groups create cadmus-web-dev-neg \
  --region="$GCP_REGION" \
  --network-endpoint-type=serverless \
  --cloud-run-service=cadmus-web-dev 2>/dev/null || echo "  (already exists)"

# ── 3. Create backend services for Cloud Run ────────────────────────────────
echo "→ Creating backend service for API..."
gcloud compute backend-services create cadmus-api-dev-backend \
  --global \
  --load-balancing-scheme=EXTERNAL_MANAGED 2>/dev/null || echo "  (already exists)"

gcloud compute backend-services add-backend cadmus-api-dev-backend \
  --global \
  --network-endpoint-group=cadmus-api-dev-neg \
  --network-endpoint-group-region="$GCP_REGION" 2>/dev/null || echo "  (already exists)"

echo "→ Creating backend service for Web..."
gcloud compute backend-services create cadmus-web-dev-backend \
  --global \
  --load-balancing-scheme=EXTERNAL_MANAGED 2>/dev/null || echo "  (already exists)"

gcloud compute backend-services add-backend cadmus-web-dev-backend \
  --global \
  --network-endpoint-group=cadmus-web-dev-neg \
  --network-endpoint-group-region="$GCP_REGION" 2>/dev/null || echo "  (already exists)"

# ── 4. Create backend bucket for admin SPA ──────────────────────────────────
echo "→ Creating backend bucket for admin SPA..."
gcloud compute backend-buckets create cadmus-admin-dev-bucket \
  --gcs-bucket-name="$ADMIN_BUCKET" \
  --enable-cdn 2>/dev/null || echo "  (already exists)"

# ── 5. Create URL map with host-based routing ───────────────────────────────
echo "→ Creating URL map with host routing..."

cat > /tmp/cadmus-dev-urlmap.yaml <<YAML
defaultService: projects/${GCP_PROJECT}/global/backendServices/cadmus-web-dev-backend
hostRules:
  - hosts: ['api.dev.cadmus.digital']
    pathMatcher: api
  - hosts: ['admin.dev.cadmus.digital']
    pathMatcher: admin
  - hosts: ['*.dev.cadmus.digital']
    pathMatcher: web
pathMatchers:
  - name: api
    defaultService: projects/${GCP_PROJECT}/global/backendServices/cadmus-api-dev-backend
  - name: admin
    defaultService: projects/${GCP_PROJECT}/global/backendBuckets/cadmus-admin-dev-bucket
  - name: web
    defaultService: projects/${GCP_PROJECT}/global/backendServices/cadmus-web-dev-backend
YAML

# Try create, fall back to import (update)
if ! gcloud compute url-maps create cadmus-dev-urlmap \
  --default-service=cadmus-web-dev-backend \
  --global 2>/dev/null; then
  echo "  (already exists, updating)"
fi

gcloud compute url-maps import cadmus-dev-urlmap \
  --source=/tmp/cadmus-dev-urlmap.yaml \
  --global --quiet

# ── 6. Create placeholder SSL cert (replaced with CF origin cert later) ─────
echo "→ Creating placeholder SSL certificate..."
gcloud compute ssl-certificates create cadmus-dev-origin-cert \
  --domains="origin.dev.cadmus.digital" \
  --global 2>/dev/null || echo "  (already exists)"

# ── 7. Create HTTPS target proxy ────────────────────────────────────────────
echo "→ Creating HTTPS target proxy..."
gcloud compute target-https-proxies create cadmus-dev-https-proxy \
  --ssl-certificates=cadmus-dev-origin-cert \
  --url-map=cadmus-dev-urlmap \
  --global 2>/dev/null || echo "  (already exists)"

# ── 8. Create forwarding rule ───────────────────────────────────────────────
echo "→ Creating forwarding rule..."
gcloud compute forwarding-rules create cadmus-dev-fwd-rule \
  --global \
  --load-balancing-scheme=EXTERNAL_MANAGED \
  --target-https-proxy=cadmus-dev-https-proxy \
  --address=cadmus-dev-lb-ip \
  --ports=443 2>/dev/null || echo "  (already exists)"

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  Dev load balancer created!"
echo ""
echo "  Static IP: $LB_IP"
echo ""
echo "  Next steps:"
echo ""
echo "  1. In Cloudflare, create an Origin Certificate:"
echo "     SSL/TLS > Origin Server > Create Certificate"
echo "     Hostnames: *.dev.cadmus.digital, dev.cadmus.digital"
echo "     Save the cert (.pem) and key (.key)"
echo ""
echo "  2. Upload the cert to GCP (replacing the placeholder):"
echo "     gcloud compute ssl-certificates create cadmus-dev-cf-origin-cert \\"
echo "       --certificate=cert.pem --private-key=key.key --global"
echo "     gcloud compute target-https-proxies update cadmus-dev-https-proxy \\"
echo "       --ssl-certificates=cadmus-dev-cf-origin-cert --global"
echo ""
echo "  3. Add DNS records in Cloudflare (all proxied/orange cloud):"
echo "     A      origin.dev  →  $LB_IP                       (DNS only / gray)"
echo "     CNAME  api.dev     →  origin.dev.cadmus.digital    (Proxied)"
echo "     CNAME  admin.dev   →  origin.dev.cadmus.digital    (Proxied)"
echo "     CNAME  *.dev       →  origin.dev.cadmus.digital    (Proxied)"
echo ""
echo "  No Cloudflare Origin Rules needed — everything routes through the LB."
echo ""
echo "════════════════════════════════════════════════════════════"
