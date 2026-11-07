#!/usr/bin/env bash
# Build, validate and run Wrangler dry-run through the Deno-owned launcher.
# This script never performs a real deployment.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/deploy-dry-run.sh" "$@"
fi

WRANGLER_CONFIG="$PROJECT_ROOT/dist/worker/wrangler.json"

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for the Wrangler dry-run, but it is not on PATH." >&2
    echo "       Install the pinned toolchain with: mise install" >&2
    exit 1
fi

DENO_BIN="$(readlink -f "$(command -v deno)")"
if [[ -z "$DENO_BIN" || ! -x "$DENO_BIN" ]]; then
    echo "ERROR: could not resolve an executable Deno binary." >&2
    exit 1
fi

TOOLCHAIN_ROOT="$(readlink -f "${TOOLCHAIN_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/web-ts7-vite/toolchain}")"
if [[ -z "$TOOLCHAIN_ROOT" || ! -f "$TOOLCHAIN_ROOT/toolchain.json" ]]; then
    echo "ERROR: the toolchain is not installed." >&2
    echo "       Provision it with: deno task toolchain:install" >&2
    exit 1
fi

echo "Building application..."
deno task build

if [[ ! -f "$WRANGLER_CONFIG" ]]; then
    echo "Generated Wrangler configuration not found: $WRANGLER_CONFIG" >&2
    exit 1
fi

echo "Checking deployment artefacts..."
deno task check:deploy

echo "Running Wrangler dry-run..."
deno run \
    --allow-read="$PROJECT_ROOT,$TOOLCHAIN_ROOT" \
    --allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,TOOLCHAIN_ROOT \
    --allow-run="$DENO_BIN" \
    scripts/wrangler-dry-run.mjs "$@"
