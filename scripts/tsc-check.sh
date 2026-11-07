#!/usr/bin/env bash
# Typecheck one application project with the toolchain-owned TypeScript.
#
# Usage: scripts/tsc-check.sh <tsconfig>
#
# Node is excluded: this script enters the same PATH tripwire as every other
# project-owned task, and the compiler is the installation's native TypeScript
# binary. Application workflows never install, resolve or write into the
# toolchain; the derived overlay lives in the application's `.wrangler/` state.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/tsc-check.sh" "$@"
fi

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for typechecking, but it is not on PATH." >&2
    echo "       Install the pinned toolchain with: mise install" >&2
    exit 1
fi

DENO_BIN="$(readlink -f "$(command -v deno)")"
if [[ -z "$DENO_BIN" || ! -x "$DENO_BIN" ]]; then
    echo "ERROR: could not resolve an executable Deno binary." >&2
    exit 1
fi

# The launcher resolves the compiler from the installation; ask it once so the
# parent can grant `--allow-run` on that exact executable. The launcher also
# asserts the pinned Deno and the installation's completeness.
TSC="$(deno run --allow-read --allow-env scripts/tsc-check.mjs --print-tsc)"
if [[ -z "$TSC" || ! -x "$TSC" ]]; then
    echo "ERROR: could not resolve the toolchain TypeScript compiler." >&2
    echo "       Provision the toolchain with: deno task toolchain:install" >&2
    exit 1
fi

deno run \
    --allow-read \
    --allow-env \
    --allow-write="$PROJECT_ROOT/.wrangler" \
    --allow-run="$TSC" \
    scripts/tsc-check.mjs "$@"
