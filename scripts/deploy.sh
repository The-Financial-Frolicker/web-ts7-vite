#!/usr/bin/env bash
# Build, package and deploy: the combined convenience path.
#
# The lifecycle is split deliberately, so that a build job can hand an artefact
# to an independent deployment job:
#
#   scripts/deploy.sh              build → package → deploy (this file)
#   scripts/deploy-artefact.sh     deploy an existing hand-off (never builds)
#
# This script owns the build half only. It produces the artefact hand-off and
# then hands the deployment to scripts/deploy-artefact.sh, so there is one
# deployment implementation and both callers exercise it.
#
# Node is excluded: this script enters the same PATH tripwire as every other
# project-owned task, and the deployment runs Wrangler under Deno with the
# profile in scripts/wrangler-deploy.mjs:
#
#   read, env, sys, write=<app>/.wrangler, run=<real esbuild>, net=api.cloudflare.com
#
# Usage: scripts/deploy.sh [--name WORKER] [wrangler arguments...]
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/deploy.sh" "$@"
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

mkdir -p "$PROJECT_ROOT/.wrangler/tmp" \
    "$PROJECT_ROOT/.wrangler/xdg" \
    "$PROJECT_ROOT/.wrangler/logs"

echo "Building application..."
deno task build

echo "Packaging the artefact hand-off..."
deno task artefact:pack

# One deployment implementation: the deployment-only interface consumes the
# hand-off this launcher has just produced. Splitting the two responsibilities
# (build here, deploy there) is what lets the build job hand an artefact to an
# independent deployment job.
echo "Deploying..."
exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deploy-artefact.sh" "$@"
