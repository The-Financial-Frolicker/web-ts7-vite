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

TOOLCHAIN_ROOT="$(readlink -f "${TOOLCHAIN_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/web-ts7-vite/toolchain}")"
if [[ -z "$TOOLCHAIN_ROOT" || ! -d "$TOOLCHAIN_ROOT" ]]; then
    echo "ERROR: no installed toolchain. Provision it with: deno task toolchain:install" >&2
    exit 1
fi

deno run \
    --allow-read="$PROJECT_ROOT,$TOOLCHAIN_ROOT" \
    --allow-env \
    scripts/contracts/cli.mjs verify "$@"
