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

# Generator-owned dependency installation. The rule matches
# scripts/lib/toolchain/runtime.mjs: the tree must resolve inside
# <GENERATOR_PROJECT_ROOT>/generator, and a temporary test-application copy
# names the generator checkout through GENERATOR_PROJECT_ROOT so it reuses the
# one installation instead of creating its own.
if [[ -z "${GENERATOR_PROJECT_ROOT+set}" ]]; then
    GENERATOR_PROJECT_ROOT="$PROJECT_ROOT"
elif [[ -z "$GENERATOR_PROJECT_ROOT" ]]; then
    echo "ERROR: GENERATOR_PROJECT_ROOT is set but empty" >&2
    exit 1
fi
if [[ -z "${GENERATOR_ROOT+set}" ]]; then
    GENERATOR_ROOT="$GENERATOR_PROJECT_ROOT/generator/toolchain"
elif [[ -z "$GENERATOR_ROOT" ]]; then
    echo "ERROR: GENERATOR_ROOT is set but empty" >&2
    exit 1
fi
case "$GENERATOR_ROOT" in
    /*) ;;
    *)
        echo "ERROR: GENERATOR_ROOT must be an absolute path: $GENERATOR_ROOT" >&2
        exit 1
        ;;
esac
GENERATOR_PROJECT_ROOT="$(readlink -m "$GENERATOR_PROJECT_ROOT")"
GENERATOR_ROOT="$(readlink -m "$GENERATOR_ROOT")"
case "$GENERATOR_ROOT/" in
    "$GENERATOR_PROJECT_ROOT/generator/"*) ;;
    *)
        echo "ERROR: generator installation root $GENERATOR_ROOT is outside $GENERATOR_PROJECT_ROOT/generator" >&2
        exit 1
        ;;
esac
# The resolver canonicalises the owning project root as well as the tree, so a
# temporary test-application copy grants read on the generator checkout it
# reuses. When the two are the same directory the grant is unchanged.
GENERATOR_READ_PATHS="$PROJECT_ROOT,$GENERATOR_ROOT"
if [[ "$GENERATOR_PROJECT_ROOT" != "$PROJECT_ROOT" ]]; then
    GENERATOR_READ_PATHS="$GENERATOR_READ_PATHS,$GENERATOR_PROJECT_ROOT"
fi
if [[ -z "$GENERATOR_ROOT" || ! -d "$GENERATOR_ROOT" ]]; then
    echo "ERROR: no installed toolchain. Provision it with: deno task toolchain:install" >&2
    exit 1
fi

deno run \
    --allow-read="$GENERATOR_READ_PATHS" \
    --allow-env \
    scripts/contracts/cli.mjs verify "$@"
