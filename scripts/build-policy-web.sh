#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack is required to build the policy WASM package."
  echo "Install: cargo install wasm-pack"
  exit 1
fi

OUT_DIR="$(pwd)/build/policy-web"
ASSET_DIR="web/public/policy-wasm"

wasm-pack build crates/policy \
  --target web \
  --out-dir "$OUT_DIR" \
  --out-name policy \
  --features wasm

mkdir -p "$ASSET_DIR"
cp "$OUT_DIR/policy.js" "$ASSET_DIR/policy.js"
cp "$OUT_DIR/policy_bg.wasm" "$ASSET_DIR/policy_bg.wasm"
cp "$OUT_DIR/policy.d.ts" "$ASSET_DIR/policy.d.ts"

if command -v wasm-opt >/dev/null 2>&1; then
  if ! wasm-opt -Oz \
    --enable-reference-types \
    --enable-bulk-memory \
    --enable-nontrapping-float-to-int \
    --enable-exception-handling \
    "$ASSET_DIR/policy_bg.wasm" -o "$ASSET_DIR/policy_bg.wasm"; then
    echo "wasm-opt failed for policy wasm; keeping unoptimized artifact"
  fi
fi

echo "Policy WASM ready in $ASSET_DIR"
