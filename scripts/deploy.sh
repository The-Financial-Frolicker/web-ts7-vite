#!/usr/bin/env bash
# Build, validate and deploy the application through the Deno-owned launchers.
#
# Node is excluded: this script enters the same PATH tripwire as every other
# project-owned task, and the deployment itself runs Wrangler under Deno with the
# profile in scripts/wrangler-deploy.mjs:
#
#   read, env, sys, write=<app>/.wrangler, run=<real esbuild>, net=api.cloudflare.com
#
# Usage: scripts/deploy.sh [wrangler arguments...]
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/deploy.sh" "$@"
fi

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for deployment, but it is not on PATH." >&2
    echo "       Install the pinned toolchain with: mise install" >&2
    exit 1
fi

DENO_BIN="$(readlink -f "$(command -v deno)")"
if [[ -z "$DENO_BIN" || ! -x "$DENO_BIN" ]]; then
    echo "ERROR: could not resolve an executable Deno binary." >&2
    exit 1
fi

mkdir -p "$PROJECT_ROOT/.wrangler/tmp" \
    "$PROJECT_ROOT/.wrangler/xdg" \
    "$PROJECT_ROOT/.wrangler/logs"

echo "Building application..."
deno task build

WRANGLER_CONFIG="$PROJECT_ROOT/dist/worker/wrangler.json"
if [[ ! -f "$WRANGLER_CONFIG" ]]; then
    echo "Generated Wrangler configuration not found: $WRANGLER_CONFIG" >&2
    exit 1
fi

echo "Checking deployment artefacts..."
deno task check:deploy

echo "Running Wrangler under Deno..."
deno run \
    --allow-read \
    --allow-env \
    --allow-run="$DENO_BIN" \
    scripts/wrangler-deploy.mjs "$@"
