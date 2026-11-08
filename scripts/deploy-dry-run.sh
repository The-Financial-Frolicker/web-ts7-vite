#!/usr/bin/env bash
# Build, validate and run Wrangler dry-run through the Deno-owned launcher.
# This script never performs a real deployment.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/deploy-dry-run.sh" "$@"
fi

WRANGLER_CONFIG="$PROJECT_ROOT/dist/worker/wrangler.json"

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for the Wrangler dry-run, but it is not on PATH." >&2
    echo "       Install the pinned toolchain with: mise install" >&2
    exit 1
fi

DENO_BIN="$(readlink -f "$(command -v deno)")"
if [[ -z "$DENO_BIN" || ! -x "$DENO_BIN" ]]; then
    echo "ERROR: could not resolve an executable Deno binary." >&2
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
    GENERATOR_ROOT="$GENERATOR_PROJECT_ROOT/generator/dependencies"
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
if [[ -z "$GENERATOR_ROOT" || ! -f "$GENERATOR_ROOT/toolchain.json" ]]; then
    echo "ERROR: the toolchain is not installed." >&2
    echo "       Provision it with: deno task toolchain:install" >&2
    exit 1
fi

echo "Building application..."
deno task build

if [[ ! -f "$WRANGLER_CONFIG" ]]; then
    echo "Generated Wrangler configuration not found: $WRANGLER_CONFIG" >&2
    exit 1
fi

echo "Checking deployment artefacts..."
deno task check:deploy

echo "Running Wrangler dry-run..."
deno run \
    --allow-read="$GENERATOR_READ_PATHS" \
    --allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,GENERATOR_ROOT,GENERATOR_PROJECT_ROOT \
    --allow-run="$DENO_BIN" \
    scripts/wrangler-dry-run.mjs "$@"
