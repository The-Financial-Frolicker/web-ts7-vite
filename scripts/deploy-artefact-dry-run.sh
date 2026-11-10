#!/usr/bin/env bash
# Validate an already-built artefact and run the Wrangler dry-run. Never builds.
#
# Usage: scripts/deploy-artefact-dry-run.sh [--name WORKER] [wrangler arguments...]
#
# The dry-run half of the deployment-only interface. It performs exactly the
# checks `scripts/deploy-artefact.sh` performs — hand-off verification, then the
# deployment-artefact compatibility check — and then runs the existing Deno-owned
# dry-run launcher, which owns the B5 deployment runtime check and the permission
# profile. No credentials are needed and nothing is uploaded.
#
# The dry-run launcher always runs `deploy --config <generated> --dry-run` and
# appends its arguments, so `--name` becomes `--dry-run --name <worker>`: the
# same payload, a different deployment identity, still no upload.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/deploy-artefact-dry-run.sh" "$@"
fi

WRANGLER_CONFIG="$PROJECT_ROOT/dist/worker/wrangler.json"
MANIFEST="$PROJECT_ROOT/artefact-manifest.json"

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

WORKER_NAME=""
while (( $# > 0 )); do
    case "$1" in
        --name)
            if [[ -n "${2:-}" && "${2:-}" != -* ]]; then
                WORKER_NAME="$2"
                shift 2
                continue
            fi
            echo "ERROR: --name requires a Worker name." >&2
            exit 1
            ;;
        --name=*)
            WORKER_NAME="${1#--name=}"
            if [[ -z "$WORKER_NAME" || "$WORKER_NAME" == -* ]]; then
                echo "ERROR: --name requires a Worker name." >&2
                exit 1
            fi
            shift
            continue
            ;;
        --)
            # `deno task <name> -- <args>` forwards the separator literally.
            shift
            continue
            ;;
        *)
            break
            ;;
    esac
done

# Deployment dependency installation. The rule matches
# scripts/lib/toolchain/runtime.mjs: the tree must resolve inside
# <GENERATOR_PROJECT_ROOT>/generator, and the deployment tree is a sibling of the
# toolchain tree (`generator/deployment` vs `generator/toolchain`). Nothing
# here reads or requires the toolchain installation.
if [[ -z "${GENERATOR_PROJECT_ROOT+set}" ]]; then
    GENERATOR_PROJECT_ROOT="$PROJECT_ROOT"
elif [[ -z "$GENERATOR_PROJECT_ROOT" ]]; then
    echo "ERROR: GENERATOR_PROJECT_ROOT is set but empty" >&2
    exit 1
fi
GENERATOR_PROJECT_ROOT="$(readlink -m "$GENERATOR_PROJECT_ROOT")"
GENERATOR_SUBROOT="$GENERATOR_PROJECT_ROOT/generator"
DEPLOYMENT_ROOT="${DEPLOYMENT_ROOT:-$GENERATOR_SUBROOT/deployment}"
case "$DEPLOYMENT_ROOT" in
    /*) ;;
    *)
        echo "ERROR: DEPLOYMENT_ROOT must be an absolute path: $DEPLOYMENT_ROOT" >&2
        exit 1
        ;;
esac
DEPLOYMENT_ROOT="$(readlink -m "$DEPLOYMENT_ROOT")"
case "$DEPLOYMENT_ROOT/" in
    "$GENERATOR_SUBROOT/"*) ;;
    *)
        echo "ERROR: deployment installation root $DEPLOYMENT_ROOT is outside $GENERATOR_SUBROOT" >&2
        exit 1
        ;;
esac

# The resolver canonicalises the owning project root as well as the tree, so a
# deployment tree grants read on the installation it uses.
DEPLOYMENT_READ_PATHS="$PROJECT_ROOT,$DEPLOYMENT_ROOT"
if [[ "$GENERATOR_PROJECT_ROOT" != "$PROJECT_ROOT" ]]; then
    DEPLOYMENT_READ_PATHS="$DEPLOYMENT_READ_PATHS,$GENERATOR_PROJECT_ROOT"
fi
if [[ ! -f "$DEPLOYMENT_ROOT/deployment.json" ]]; then
    echo "ERROR: the deployment dependencies are not installed." >&2
    echo "       Provision them with: deno task deployment:install" >&2
    exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
    echo "ERROR: no artefact hand-off found: $MANIFEST" >&2
    echo "       Deployment consumes the artefact produced by the build job." >&2
    echo "       Build and package it with: deno task build && deno task artefact:pack" >&2
    exit 1
fi

if [[ ! -f "$WRANGLER_CONFIG" ]]; then
    echo "Generated Wrangler configuration not found: $WRANGLER_CONFIG" >&2
    exit 1
fi

echo "Verifying the artefact hand-off..."
deno run \
    --allow-read="$DEPLOYMENT_READ_PATHS" \
    --allow-env \
    scripts/artefact.mjs verify

echo "Checking deployment artefacts..."
deno task check:deploy

EXTRA_ARGS=()
if [[ -n "$WORKER_NAME" ]]; then
    EXTRA_ARGS=(--name "$WORKER_NAME")
    echo "Dry-running the built artefact as Worker \"$WORKER_NAME\" (no build step)."
else
    echo "Dry-running the built artefact under its generated Worker name (no build step)."
fi

echo "Running Wrangler dry-run..."
deno run \
    --allow-read="$DEPLOYMENT_READ_PATHS" \
    --allow-env=HOME,XDG_CONFIG_HOME,XDG_DATA_HOME,GENERATOR_PROJECT_ROOT,DEPLOYMENT_ROOT \
    --allow-run="$DENO_BIN" \
    scripts/wrangler-dry-run.mjs "${EXTRA_ARGS[@]}" "$@"
