#!/usr/bin/env bash
# Approve a discovered candidate. Development station only.
#
# Requires a named approver and a stated reason. Refuses when the candidate has
# an unverified value, and refuses to overwrite an approved contract unless
# --replace is given.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/contract-approve.sh" "$@"
fi

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for contract approval, but it is not on PATH." >&2
    exit 1
fi

NODE_MODULES_REAL="$(readlink -f "$PROJECT_ROOT/node_modules")"
if [[ -z "$NODE_MODULES_REAL" ]]; then
    echo "ERROR: npm dependencies are not installed." >&2
    exit 1
fi

deno run \
    --allow-read="$PROJECT_ROOT,$NODE_MODULES_REAL" \
    --allow-env \
    --allow-write="$PROJECT_ROOT/toolchain-contracts.json,$PROJECT_ROOT/.contracts" \
    scripts/contracts/author-cli.mjs approve "$@"
