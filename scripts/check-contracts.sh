#!/usr/bin/env bash
# Verify the installed toolchain and configuration against the committed lock.
#
# This is the CI-facing half of the contract model: it reads files, recomputes
# the derived facts and compares them with the committed lock. It grants read and
# env and nothing else — no run, no net, no write — which is itself the evidence
# that CI cannot derive, probe or rewrite the lock it is checked against.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/check-contracts.sh" "$@"
fi

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for contract verification, but it is not on PATH." >&2
    exit 1
fi

NODE_MODULES_REAL="$(readlink -f "$PROJECT_ROOT/node_modules")"
if [[ -z "$NODE_MODULES_REAL" ]]; then
    echo "ERROR: could not resolve the real node_modules directory." >&2
    exit 1
fi

deno run \
    --allow-read="$PROJECT_ROOT,$NODE_MODULES_REAL" \
    --allow-env \
    scripts/contracts/cli.mjs verify "$@"
