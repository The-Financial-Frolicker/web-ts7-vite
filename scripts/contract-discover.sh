#!/usr/bin/env bash
# Local contract discovery. Development station only; never run in CI.
#
# This is the only project path that executes workerd and Vite in order to learn
# what they support. It writes a candidate to .contracts/candidate.json and
# never approves anything.
#
# Usage:
#   scripts/contract-discover.sh                  discover, write the candidate
#   scripts/contract-discover.sh --print-workerd   print the runtime path only
#
# `--print-workerd` is the diagnostic mode used by the tests and for
# troubleshooting: it resolves and prints the runtime the probe would start,
# without creating a candidate, writing anything or executing a probe.
#
# Permissions are scoped to: the project and its installed dependencies (read),
# the temporary fixture root and .contracts (write), loopback (net), and the two
# executables it must start (run). No FFI, no broad net, no all-permissions.
#
# Deno's permission model gates loading and launching native code; it does not
# sandbox workerd or Vite once they run. The scoped grants limit *which*
# binaries start, not what those binaries may do afterwards.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/contract-discover.sh" "$@"
fi

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for contract discovery, but it is not on PATH." >&2
    exit 1
fi

DENO_BIN="$(readlink -f "$(command -v deno)")"
NODE_MODULES_REAL="$(readlink -f "$PROJECT_ROOT/node_modules")"
if [[ -z "$NODE_MODULES_REAL" ]]; then
    echo "ERROR: npm dependencies are not installed." >&2
    echo "       Install them with: mise exec -- deno install --frozen" >&2
    exit 1
fi

TEMP_ROOT="${TMPDIR:-/tmp}"

# Resolve the runtime the Wrangler/Miniflare graph actually selects.
#
# The path is discovered, never hardcoded, and is used only to scope the run
# permission. `workerd-path` lives in the generator-only authoring CLI: the
# product CLI (cli.mjs) implements consumption commands only and has no
# discovery commands by design. Invoking the wrong CLI here fails with
# "unknown command" before any probe runs.
resolve_workerd() {
    local workerd
    workerd="$(
        deno run \
            --allow-read="$PROJECT_ROOT,$NODE_MODULES_REAL" \
            scripts/contracts/author-cli.mjs workerd-path
    )" || return 1

    if [[ -z "$workerd" || ! -x "$workerd" ]]; then
        return 1
    fi

    printf '%s\n' "$workerd"
}

# Diagnostic mode: resolve and print the runtime, then stop.
if [[ "${1:-}" == "--" ]]; then
    shift
fi
if [[ "${1:-}" == "--print-workerd" ]]; then
    if ! WORKERD_PATH="$(resolve_workerd)"; then
        echo "ERROR: could not resolve an executable workerd binary from the" >&2
        echo "       installed Wrangler/Miniflare dependency graph." >&2
        exit 1
    fi
    printf '%s\n' "$WORKERD_PATH"
    exit 0
fi

if ! WORKERD="$(resolve_workerd)"; then
    echo "ERROR: could not resolve an executable workerd binary from the" >&2
    echo "       installed Wrangler/Miniflare dependency graph." >&2
    exit 1
fi

mkdir -p "$PROJECT_ROOT/.contracts"

deno run \
    --allow-read="$PROJECT_ROOT,$NODE_MODULES_REAL,$TEMP_ROOT" \
    --allow-env \
    --allow-sys \
    --allow-write="$PROJECT_ROOT/.contracts,$TEMP_ROOT" \
    --allow-net=127.0.0.1 \
    --allow-run="$DENO_BIN" \
    --allow-run="$WORKERD" \
    scripts/contracts/author-cli.mjs discover "$@"
