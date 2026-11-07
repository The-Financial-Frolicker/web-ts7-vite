#!/usr/bin/env bash
# Start the toolchain-owned Vite development or preview server under Deno.
#
# Usage: scripts/serve.sh dev|preview
#
# Node is excluded: this script enters the same PATH tripwire as every other
# project-owned task, and the server is a Deno process. The launcher resolves the
# real workerd executable and both real native bindings, then spawns one Deno
# child with the profile for the selected mode (see scripts/vite-server.mjs).
#
# Application state is created under the ignored `.wrangler/` tree so the child
# profile never writes outside the application.
set -euo pipefail

MODE="${1:-}"
if [[ "$MODE" != "dev" && "$MODE" != "preview" ]]; then
    echo "Usage: scripts/serve.sh dev|preview" >&2
    exit 2
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/serve.sh" "$@"
fi

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for Vite $MODE, but it is not on PATH." >&2
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

# The launcher is the only executable the parent may start. It resolves the
# toolchain, asserts the pinned Deno version and builds the child profile.
deno run \
    --allow-read \
    --allow-env \
    --allow-run="$DENO_BIN" \
    scripts/vite-server.mjs "$MODE"
