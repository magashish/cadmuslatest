#!/usr/bin/env bash
set -euo pipefail

# Release: merge dev → main, push main, wait for CI, tag next version, push tag.
#
# Usage:
#   scripts/release.sh                # patch bump (default)
#   scripts/release.sh --minor        # minor bump
#   scripts/release.sh --major        # major bump
#   scripts/release.sh -y             # skip confirmation prompt
#   scripts/release.sh -m "subject"   # override merge commit subject

BUMP="patch"
ASSUME_YES=0
MERGE_MSG_OVERRIDE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --patch) BUMP="patch"; shift ;;
    --minor) BUMP="minor"; shift ;;
    --major) BUMP="major"; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -m|--message) MERGE_MSG_OVERRIDE="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────
command -v gh >/dev/null 2>&1 || { echo "gh CLI is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh not authenticated — run 'gh auth login'" >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "working tree is not clean — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

ORIGINAL_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
restore_branch() {
  if [ "$ORIGINAL_BRANCH" != "HEAD" ] && [ "$(git rev-parse --abbrev-ref HEAD)" != "$ORIGINAL_BRANCH" ]; then
    git checkout "$ORIGINAL_BRANCH" >/dev/null 2>&1 || true
  fi
}
trap restore_branch EXIT

echo "→ fetching origin..."
git fetch origin --tags --prune

# ── Compute next version ─────────────────────────────────────────────────────
LATEST_TAG="$(git tag --list 'v*.*.*' --sort=-v:refname | head -n1 || true)"
if [ -z "$LATEST_TAG" ]; then
  CURRENT="0.0.0"
  echo "→ no v*.*.* tags found; treating current as v0.0.0"
else
  CURRENT="${LATEST_TAG#v}"
fi

IFS=. read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEXT_TAG="v${MAJOR}.${MINOR}.${PATCH}"

# ── Verify dev is ahead of main ──────────────────────────────────────────────
AHEAD="$(git rev-list --count origin/main..origin/dev)"
if [ "$AHEAD" -eq 0 ]; then
  echo "origin/dev has no commits beyond origin/main — nothing to release" >&2
  exit 1
fi

MERGE_SUBJECT="${MERGE_MSG_OVERRIDE:-Merge dev: release ${NEXT_TAG}}"

echo
echo "Plan:"
echo "  current tag:  ${LATEST_TAG:-<none>}"
echo "  next tag:     ${NEXT_TAG}  (${BUMP} bump)"
echo "  commits:      ${AHEAD} on dev not in main"
echo "  merge msg:    ${MERGE_SUBJECT}"
echo
echo "Commits to release:"
git log --oneline --no-decorate "origin/main..origin/dev" | sed 's/^/  /'
echo

if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "Proceed? [y/N] " REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "aborted"; exit 1 ;;
  esac
fi

# ── Merge dev → main ─────────────────────────────────────────────────────────
echo "→ checking out main..."
git checkout main
git pull --ff-only origin main

echo "→ merging dev with --no-ff..."
git merge --no-ff origin/dev -m "$MERGE_SUBJECT"

MERGE_SHA="$(git rev-parse HEAD)"
echo "→ merge commit: $MERGE_SHA"

echo "→ pushing main..."
git push origin main

# ── Wait for CI on the merge commit ──────────────────────────────────────────
echo "→ waiting for CI run on $MERGE_SHA..."
RUN_ID=""
for i in $(seq 1 30); do
  RUN_ID="$(gh run list --branch main --workflow CI --limit 20 \
    --json databaseId,headSha \
    --jq ".[] | select(.headSha==\"$MERGE_SHA\") | .databaseId" | head -n1)"
  if [ -n "$RUN_ID" ]; then break; fi
  sleep 4
done

if [ -z "$RUN_ID" ]; then
  echo "could not locate CI run for $MERGE_SHA after waiting; check 'gh run list' and tag manually if green" >&2
  exit 1
fi

echo "→ watching run $RUN_ID..."
if ! gh run watch "$RUN_ID" --exit-status; then
  echo "CI failed — not tagging. Investigate at: $(gh run view "$RUN_ID" --json url --jq .url 2>/dev/null || echo "gh run view $RUN_ID")" >&2
  exit 1
fi

# ── Tag and push ─────────────────────────────────────────────────────────────
echo "→ tagging $NEXT_TAG..."
git tag -a "$NEXT_TAG" -m "Release $NEXT_TAG" "$MERGE_SHA"
git push origin "$NEXT_TAG"

echo
echo "✓ released $NEXT_TAG"
echo "  deploy workflow should now be running for tag $NEXT_TAG"
