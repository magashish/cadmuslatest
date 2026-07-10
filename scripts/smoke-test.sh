#!/usr/bin/env bash
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
API_URL="${1:-https://cadmus-api-115874405946.us-central1.run.app}"
PASS=0
FAIL=0
ERRORS=""

# ── Helpers ──────────────────────────────────────────────────────────────────
check() {
  local description="$1"
  local expected_code="$2"
  shift 2
  local response
  response=$(curl -s -w "\n%{http_code}" "$@") || true
  local body=$(echo "$response" | sed '$d')
  local code=$(echo "$response" | tail -1)

  if [ "$code" = "$expected_code" ]; then
    echo "  PASS  $description ($code)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $description (expected $expected_code, got $code)"
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  - $description: expected $expected_code, got $code\n    Body: $(echo "$body" | head -1)"
  fi
  # Return body for extraction
  echo "$body" > /tmp/cadmus-smoke-last-response
}

extract() {
  # Simple JSON value extraction (no jq dependency)
  local key="$1"
  cat /tmp/cadmus-smoke-last-response | grep -o "\"${key}\":\"[^\"]*\"" | head -1 | sed "s/\"${key}\":\"\([^\"]*\)\"/\1/"
}

extract_raw() {
  local key="$1"
  cat /tmp/cadmus-smoke-last-response | grep -o "\"${key}\":[^,}]*" | head -1 | sed "s/\"${key}\"://"
}

echo "╔══════════════════════════════════════╗"
echo "║  Cadmus — Production Smoke Tests     ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Target: $API_URL"
echo ""

# ── 1. Health ────────────────────────────────────────────────────────────────
echo "── Health ──"
check "GET /api/health returns 200" 200 "$API_URL/api/health"
echo ""

# ── 2. Provision site (creates site + owner + token in one step) ─────────────
echo "── Site Provisioning ──"
TIMESTAMP=$(date +%s)
TEST_EMAIL="smoketest-${TIMESTAMP}@test.cadmus.digital"
TEST_PASS="TestPass1234"

check "POST /api/sites provisions site + owner" 201 \
  -X POST "$API_URL/api/sites" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Smoke Test Site\",\"ownerEmail\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASS}\"}"
TOKEN=$(extract "token")
SITE_ID=$(cat /tmp/cadmus-smoke-last-response | grep -o '"site":{[^}]*}' | grep -o '"id":"[^"]*"' | head -1 | sed 's/"id":"\([^"]*\)"/\1/')

if [ -z "$TOKEN" ]; then
  echo ""
  echo "FATAL: Could not get token from site provisioning. Remaining tests require auth."
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi

echo "  (site=$SITE_ID)"

# ── 3. Auth ──────────────────────────────────────────────────────────────────
echo ""
echo "── Auth ──"
check "GET /api/auth/me returns user" 200 \
  "$API_URL/api/auth/me" \
  -H "Authorization: Bearer ${TOKEN}"

check "POST /api/auth/login works" 200 \
  -X POST "$API_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${TEST_EMAIL}\",\"password\":\"${TEST_PASS}\",\"siteId\":\"${SITE_ID}\"}"
echo ""

# ── 4. Sites ─────────────────────────────────────────────────────────────────
echo "── Sites ──"

if [ -n "$SITE_ID" ]; then
  check "GET /api/sites/:id returns site" 200 \
    "$API_URL/api/sites/${SITE_ID}" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-site-id: ${SITE_ID}"

  check "GET /api/sites/:id/stats returns stats" 200 \
    "$API_URL/api/sites/${SITE_ID}/stats" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-site-id: ${SITE_ID}"
else
  echo "  SKIP  No site ID, skipping site detail tests"
fi
echo ""

# ── 5. Content CRUD ──────────────────────────────────────────────────────────
echo "── Content ──"
if [ -n "$SITE_ID" ]; then
  check "POST /api/content creates page" 201 \
    -X POST "$API_URL/api/content" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-site-id: ${SITE_ID}" \
    -d "{\"slug\":\"smoke-test-${TIMESTAMP}\",\"type\":\"page\",\"status\":\"draft\",\"blocks\":[{\"blockType\":\"paragraph\",\"data\":{\"text\":\"Hello from smoke test\"}}]}"
  CONTENT_ID=$(extract "id")

  if [ -n "$CONTENT_ID" ]; then
    check "GET /api/content/:id returns content" 200 \
      "$API_URL/api/content/${CONTENT_ID}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "x-site-id: ${SITE_ID}"

    check "GET /api/content lists content" 200 \
      "$API_URL/api/content" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "x-site-id: ${SITE_ID}"

    check "PUT /api/content/:id updates content" 200 \
      -X PUT "$API_URL/api/content/${CONTENT_ID}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "x-site-id: ${SITE_ID}" \
      -d "{\"status\":\"published\"}"

    check "GET /api/content/:id/versions lists versions" 200 \
      "$API_URL/api/content/${CONTENT_ID}/versions" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "x-site-id: ${SITE_ID}"

    check "DELETE /api/content/:id archives content" 200 \
      -X DELETE "$API_URL/api/content/${CONTENT_ID}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "x-site-id: ${SITE_ID}"
  else
    echo "  SKIP  No content ID, skipping content detail tests"
  fi
else
  echo "  SKIP  No site ID, skipping content tests"
fi
echo ""

# ── 6. Collections ───────────────────────────────────────────────────────────
echo "── Collections ──"
if [ -n "$SITE_ID" ]; then
  check "POST /api/collections creates collection" 201 \
    -X POST "$API_URL/api/collections" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-site-id: ${SITE_ID}" \
    -d "{\"name\":\"Smoke Collection\",\"slug\":\"smoke-${TIMESTAMP}\",\"type\":\"category\"}"
  COLLECTION_ID=$(extract "id")

  check "GET /api/collections lists collections" 200 \
    "$API_URL/api/collections" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-site-id: ${SITE_ID}"

  if [ -n "$COLLECTION_ID" ]; then
    check "DELETE /api/collections/:id deletes collection" 200 \
      -X DELETE "$API_URL/api/collections/${COLLECTION_ID}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "x-site-id: ${SITE_ID}"
  fi
else
  echo "  SKIP  No site ID, skipping collection tests"
fi
echo ""

# ── 7. Navigation ────────────────────────────────────────────────────────────
echo "── Navigation ──"
if [ -n "$SITE_ID" ]; then
  check "PUT /api/navigation/:location creates nav" 201 \
    -X PUT "$API_URL/api/navigation/header" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-site-id: ${SITE_ID}" \
    -d "{\"items\":[{\"label\":\"Home\",\"url\":\"/\"}]}"

  check "GET /api/navigation lists nav" 200 \
    "$API_URL/api/navigation" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-site-id: ${SITE_ID}"
else
  echo "  SKIP  No site ID, skipping navigation tests"
fi
echo ""

# ── 8. Media (listing only, no upload in smoke test) ─────────────────────────
echo "── Media ──"
if [ -n "$SITE_ID" ]; then
  check "GET /api/media lists media" 200 \
    "$API_URL/api/media" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-site-id: ${SITE_ID}"
else
  echo "  SKIP  No site ID, skipping media tests"
fi
echo ""

# ── 9. Public endpoints ──────────────────────────────────────────────────────
echo "── Public ──"
if [ -n "$SITE_ID" ]; then
  check "GET /api/public/site returns public info" 200 \
    "$API_URL/api/public/site" \
    -H "x-site-id: ${SITE_ID}"

  check "GET /api/public/content lists published" 200 \
    "$API_URL/api/public/content" \
    -H "x-site-id: ${SITE_ID}"

  check "GET /api/public/navigation returns nav" 200 \
    "$API_URL/api/public/navigation" \
    -H "x-site-id: ${SITE_ID}"
else
  echo "  SKIP  No site ID, skipping public tests"
fi
echo ""

# ── 10. Auth guards ───────────────────────────────────────────────────────────
echo "── Auth Guards ──"
check "GET /api/content without site context returns 404" 404 \
  "$API_URL/api/content"

check "GET /api/auth/me with bad token returns 401" 401 \
  "$API_URL/api/auth/me" \
  -H "Authorization: Bearer invalidtoken"
echo ""

# ── Results ──────────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo "════════════════════════════════════════"
echo "  Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  Failures:"
  echo -e "$ERRORS"
fi
echo "════════════════════════════════════════"

# Cleanup temp file
rm -f /tmp/cadmus-smoke-last-response

exit "$FAIL"
