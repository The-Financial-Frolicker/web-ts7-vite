#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

WRANGLER_ENTRY="$PROJECT_ROOT/node_modules/wrangler/bin/wrangler.js"
WRANGLER_CONFIG="$PROJECT_ROOT/dist/worker/wrangler.json"

# --- Resolve Node (project requires Node >= 22.12.0) ---------------------
if [[ -n "${NODE_BIN:-}" ]]; then
    : # explicit override preserved
else
    NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

if [[ -z "${NODE_BIN:-}" ]]; then
    echo "ERROR: no Node.js found. The project requires Node >= 22.12.0." >&2
    echo "Install Node >= 22.12.0 (e.g. mise install), or set NODE_BIN to an explicit Node executable." >&2
    exit 1
fi

if [[ ! -x "$NODE_BIN" ]]; then
    echo "ERROR: Node executable not found or not executable: $NODE_BIN" >&2
    exit 1
fi

NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"
NODE_VERSION="${NODE_VERSION#v}"
if [[ ! "$NODE_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(\+[0-9A-Za-z.-]+)?$ ]]; then
    echo "ERROR: could not parse a stable Node.js version from '$NODE_BIN --version' (got: '$NODE_VERSION'). The project requires a stable Node >= 22.12.0 (prereleases are rejected)." >&2
    exit 1
fi

NODE_MAJOR="${BASH_REMATCH[1]}"
NODE_MINOR="${BASH_REMATCH[2]}"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 12) )); then
    echo "ERROR: the project requires Node >= 22.12.0, but $NODE_BIN is $NODE_VERSION." >&2
    echo "Switch to a Node >= 22.12.0 (e.g. mise exec -- ...), or set NODE_BIN to one." >&2
    exit 1
fi

if [[ ! -f "$WRANGLER_ENTRY" ]]; then
    echo "Wrangler entry point not found: $WRANGLER_ENTRY" >&2
    exit 1
fi

echo "Building application..."
deno task build

if [[ ! -f "$WRANGLER_CONFIG" ]]; then
    echo "Generated Wrangler configuration not found: $WRANGLER_CONFIG" >&2
    exit 1
fi

echo "Running Wrangler..."
"$NODE_BIN" "$WRANGLER_ENTRY" deploy \
    --config "$WRANGLER_CONFIG" "$@"
