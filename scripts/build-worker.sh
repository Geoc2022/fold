#!/usr/bin/env bash
# Build the Rust Worker to build/worker/shim.mjs + build/index_bg.wasm.
#
# We use `worker-build --dev` on purpose. worker-build injects
# `--force-enable-abort-handler` on its release path, which the wasm-bindgen
# version required by `worker` 0.8 (>=0.2.125) compiles into externref "catch
# wrappers" that fail to build on the current toolchain. The `--dev` path skips
# that flag and produces a correct, working module (reference-types + critical
# error recovery glue are still emitted).
#
# The resulting WASM is unoptimized (~1.5 MB, under the 3 MB free-plan cap). If
# `wasm-opt` (binaryen) is on PATH we shrink it further for production.
set -euo pipefail
cd "$(dirname "$0")/.."

worker-build --dev

WASM="build/index_bg.wasm"
if [ -f "$WASM" ]; then
  if command -v wasm-opt >/dev/null 2>&1; then
    echo "wasm-opt: optimizing $WASM (-Oz)"
    # --enable-exception-handling is required: worker-build's `--dev` path emits
    # exception-handling tags (critical-error recovery glue) that wasm-opt must
    # be told to allow, or validation fails. Keep failure non-fatal -- the
    # unoptimized WASM is still well under the 3 MB free-plan cap (~0.8 MB
    # gzipped), so a wasm-opt hiccup must never break the build/CI.
    if ! wasm-opt -Oz \
      --enable-reference-types \
      --enable-bulk-memory \
      --enable-nontrapping-float-to-int \
      --enable-exception-handling \
      "$WASM" -o "$WASM"; then
      echo "wasm-opt failed; keeping unoptimized WASM (still under the 3 MB cap)."
    fi
  else
    echo "wasm-opt not found; skipping size optimization (dev WASM is under the 3 MB cap)."
  fi
  echo "Worker WASM size: $(du -h "$WASM" | cut -f1)"
fi
