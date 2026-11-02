#!/usr/bin/env bash
# CI-equivalent validation for this repository.
#
# The repository is a starter template whose identity placeholders are
# deliberately not valid Cloudflare Worker names, so the template itself cannot
# be built or deployed. This script therefore:
#
#   1. runs the checks that work directly on the template (formatting, linting,
#      typechecks and the project-initialisation tests), and
#   2. validates the full build in a throwaway copy of the working tree whose
#      identity has been initialised with a sample name.
#
# The checked-out working tree is never modified, so this is safe to run on a
# template or on an already initialised project (where the initialisation step
# is a no-op).
#
# Run it through the pinned toolchain, for example:
#     mise exec -- deno task ci
# or a single stage:
#     mise exec -- bash scripts/ci.sh static
#     mise exec -- bash scripts/ci.sh build
#
# Dependencies must already be installed (`mise exec -- deno install --frozen`).
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

STAGE="${1:-all}"
WORK_DIR=""

cleanup() {
    if [[ -n "$WORK_DIR" ]]; then
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

require_dependencies() {
    if [[ ! -d "$PROJECT_ROOT/node_modules" ]]; then
        echo "ERROR: node_modules is missing. Install dependencies first:" >&2
        echo "    mise exec -- deno install --frozen" >&2
        exit 1
    fi
}

run_static_checks() {
    echo "==> Formatting check"
    deno task fmt:check
    echo "==> Lint check"
    deno task lint
    echo "==> Client typecheck"
    deno task check:client
    echo "==> Worker typecheck"
    deno task check:worker
    echo "==> Project initialisation tests"
    deno task test:init
}

run_build_checks() {
    require_dependencies

    WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/web-ts7-vite-ci.XXXXXX")"

    echo "==> Prepare an initialised build copy in $WORK_DIR"
    # Copy the working tree, including uncommitted changes, but not generated
    # output. node_modules is shared through a symlink so dependencies are not
    # installed twice.
    tar -C "$PROJECT_ROOT" \
        --exclude=./.git \
        --exclude=./node_modules \
        --exclude=./dist \
        --exclude=./build-wasm \
        --exclude=./.wrangler \
        --exclude=./public/wasm \
        --exclude='./.aider*' \
        -cf - . | tar -C "$WORK_DIR" -xf -
    ln -s "$PROJECT_ROOT/node_modules" "$WORK_DIR/node_modules"

    cd "$WORK_DIR"

    echo "==> Initialise a throwaway project identity"
    # The placeholder is not a valid Worker name, so Wrangler and the
    # Cloudflare Vite plugin refuse to run on an untouched template. An already
    # initialised project is a no-op here.
    node scripts/init-project.mjs ci-smoke

    echo "==> Generated Worker types freshness check"
    deno task check:worker-types

    echo "==> WASM build, typechecks and Vite build"
    deno task build

    echo "==> WASM smoke test (build tree)"
    deno task test:wasm

    echo "==> Published-artifact smoke test (dist/client)"
    deno task test:wasm:published

    echo "==> Wrangler deployment dry run (no credentials required)"
    deno task deploy:dry-run

    echo "CI-equivalent validation complete."
}

case "$STAGE" in
    static) run_static_checks ;;
    build) run_build_checks ;;
    all)
        run_static_checks
        run_build_checks
        ;;
    *)
        echo "ERROR: unknown stage: $STAGE" >&2
        echo "Usage: scripts/ci.sh [static|build|all]" >&2
        exit 1
        ;;
esac
