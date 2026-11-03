#!/usr/bin/env bash
# Generate or check Worker types through the Deno-owned Wrangler adapter.
# Usage: scripts/worker-types.sh [--check]
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/worker-types.sh" "$@"
fi

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for Worker type generation, but it is not on PATH." >&2
    echo "       Install the pinned toolchain with: mise install" >&2
    exit 1
fi

DENO_BIN="$(readlink -f "$(command -v deno)")"
if [[ -z "$DENO_BIN" || ! -x "$DENO_BIN" ]]; then
    echo "ERROR: could not resolve an executable Deno binary." >&2
    exit 1
fi

if [[ ! -d "$PROJECT_ROOT/node_modules" ]]; then
    echo "ERROR: npm dependencies are not installed." >&2
    echo "       Install them with: mise exec -- deno install --frozen" >&2
    exit 1
fi

NODE_MODULES_REAL="$(readlink -f "$PROJECT_ROOT/node_modules")"
if [[ -z "$NODE_MODULES_REAL" ]]; then
    echo "ERROR: could not resolve the real node_modules directory." >&2
    exit 1
fi

# The launcher is the only executable the parent may start, and the child
# receives its own explicit Wrangler-types permission profile.
deno run \
    --allow-read="$PROJECT_ROOT,$NODE_MODULES_REAL" \
    --allow-run="$DENO_BIN" \
    scripts/wrangler-types.mjs "$@"
