#!/usr/bin/env bash
# Deploy an already-built artefact. Never builds.
#
# Usage: scripts/deploy-artefact.sh [--name WORKER] [wrangler arguments...]
#
# The deployment input is the hand-off produced by `deno task artefact:pack`:
#
#   <project>/artefact-manifest.json   the build identity and payload digest
#   <project>/dist/                    the deployable payload
#
# This script is the deployment half of the lifecycle. It verifies the hand-off,
# runs the existing deployment-artefact compatibility check, and then invokes
# Wrangler through the existing Deno launcher, which owns the B5 deployment
# runtime check and the permission profile. It does not run `deno task build`,
# `scripts/build.sh`, Vite, Emscripten, CMake or Ninja, and it needs no source
# tree: only the payload, the hand-off record, `package.json` (project identity)
# and `.mise.toml` (the Deno pin `runtimePolicy` reads).
#
# `--name` supplies the Worker name at deployment time. The payload is not
# touched: `wrangler deploy --name` overrides the generated configuration's name,
# so one hand-off can be deployed under two different names. Explicit Wrangler
# arguments replace the default command entirely (the launcher's documented
# convention), so they cannot be combined with `--name`.
#
#   scripts/deploy-artefact.sh                                   deploy as built
#   scripts/deploy-artefact.sh --name edge-1234-1                deploy under another name
#   scripts/deploy-artefact.sh deployments status --name x --json read-only query
#
# Node is excluded, as in the combined launcher this replaces.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/deploy-artefact.sh" "$@"
fi

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for deployment, but it is not on PATH." >&2
    echo "       Install the pinned toolchain with: mise install" >&2
    exit 1
fi

DENO_BIN="$(readlink -f "$(command -v deno)")"
if [[ -z "$DENO_BIN" || ! -x "$DENO_BIN" ]]; then
    echo "ERROR: could not resolve an executable Deno binary." >&2
    exit 1
fi

# --- Deployment identity -----------------------------------------------------
# Only the default command takes a name. Explicit Wrangler arguments are passed
# to the launcher verbatim, which replaces the default command, so a name given
# alongside them would be ambiguous rather than additive.
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
WRANGLER_ARGS=("$@")
if [[ -n "$WORKER_NAME" && ${#WRANGLER_ARGS[@]} -gt 0 ]]; then
    echo "ERROR: --name cannot be combined with explicit Wrangler arguments." >&2
    echo "       Wrangler arguments replace the default command; use the name" >&2
    echo "       inside them (for example: deploy --config <config> --name x)." >&2
    exit 1
fi

MANIFEST="$PROJECT_ROOT/artefact-manifest.json"
WRANGLER_CONFIG="$PROJECT_ROOT/dist/worker/wrangler.json"

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

mkdir -p "$PROJECT_ROOT/.wrangler/tmp" \
    "$PROJECT_ROOT/.wrangler/xdg" \
    "$PROJECT_ROOT/.wrangler/logs"

echo "Verifying the artefact hand-off..."
deno run \
    --allow-read \
    --allow-env \
    scripts/artefact.mjs verify

echo "Checking deployment artefacts..."
deno task check:deploy

DEPLOY_ARGS=(deploy --config "$WRANGLER_CONFIG")
if [[ -n "$WORKER_NAME" ]]; then
    DEPLOY_ARGS+=(--name "$WORKER_NAME")
    echo "Deploying the built artefact as Worker \"$WORKER_NAME\" (no build step)."
else
    echo "Deploying the built artefact under its generated Worker name (no build step)."
fi

if [[ ${#WRANGLER_ARGS[@]} -gt 0 ]]; then
    echo "Running Wrangler under Deno with the supplied command..."
    deno run \
        --allow-read \
        --allow-env \
        --allow-run="$DENO_BIN" \
        scripts/wrangler-deploy.mjs "${WRANGLER_ARGS[@]}"
else
    echo "Running Wrangler under Deno..."
    deno run \
        --allow-read \
        --allow-env \
        --allow-run="$DENO_BIN" \
        scripts/wrangler-deploy.mjs "${DEPLOY_ARGS[@]}"
fi
