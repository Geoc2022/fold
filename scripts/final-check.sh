#!/usr/bin/env bash
set -euo pipefail

# Final local verification pass before deploy.
#
# Usage:
#   scripts/final-check.sh           # run checks + wrangler dev smoke test
#   scripts/final-check.sh --serve   # run checks, then start wrangler dev interactively
#   SKIP_INSTALL=1 scripts/final-check.sh

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

SMOKE_PORT="${SMOKE_PORT:-8787}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"
SERVE_MODE=0

if [[ "${1:-}" == "--serve" ]]; then
  SERVE_MODE=1
elif [[ -n "${1:-}" ]]; then
  echo "Unknown option: $1"
  echo "Usage: scripts/final-check.sh [--serve]"
  exit 2
fi

step() {
  echo
  echo "==> $1"
}

step "Regenerate and verify generated language docs"
REGEN_DOCS=1 cargo test -p policy --test docs_up_to_date

if ! git diff --quiet -- docs/language.md; then
  echo "NOTE: docs/language.md changed during regeneration."
  echo "      Review and commit it before deploy if intended."
fi

step "Rust tests (workspace)"
cargo test --workspace

if [[ "$SKIP_INSTALL" != "1" ]]; then
  step "Install web dependencies"
  npm ci --prefix web
fi

step "Web lint"
npm --prefix web run lint

step "Web tests"
npm --prefix web run test

step "Web build"
npm --prefix web run build

step "Apply local D1 migrations"
npx wrangler d1 migrations apply fold-db --local

if [[ "$SERVE_MODE" == "1" ]]; then
  step "Starting wrangler dev (interactive)"
  exec npx wrangler dev --port "$SMOKE_PORT"
fi

step "Wrangler dev smoke test"
DEV_LOG="$(mktemp -t fold-wrangler-dev-log.XXXXXX)"
cleanup() {
  if [[ -n "${DEV_PID:-}" ]] && kill -0 "$DEV_PID" >/dev/null 2>&1; then
    kill "$DEV_PID" >/dev/null 2>&1 || true
    wait "$DEV_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

npx wrangler dev --port "$SMOKE_PORT" >"$DEV_LOG" 2>&1 &
DEV_PID=$!

HEALTH_URL="http://127.0.0.1:${SMOKE_PORT}/api/health"
for _ in {1..30}; do
  if curl --silent --fail "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Smoke check passed: $HEALTH_URL"
    break
  fi
  sleep 1
done

if ! curl --silent --fail "$HEALTH_URL" >/dev/null 2>&1; then
  echo "Smoke check failed. wrangler dev logs:"
  cat "$DEV_LOG"
  exit 1
fi

echo
echo "All final checks passed. Ready to deploy."
