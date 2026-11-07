#!/usr/bin/env bash
# CI-equivalent validation for this repository.
#
# The repository is a starter template whose identity placeholders are
# deliberately not valid Cloudflare Worker names, so the template itself cannot
# be built or deployed. This script therefore:
#
#   1. runs the checks that work directly on the template (formatting, linting,
#      typechecks, the Node dependency-boundary checks and tests, the
#      project-initialisation tests and the Worker runtime tests), and
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
# Dependencies are not installed by this script and must never be resolved here.
#
# Two separate lifecycles precede it, both generator-owned:
#
#   mise exec -- deno task toolchain:prepare   pinned tool binaries + `.mise.toml`
#   mise exec -- deno task toolchain:install   the external npm dependency domain
#
# The first projects and verifies the mise-managed tools; the second materialises
# the toolchain's own manifests and lock into an installation outside this
# checkout. Ordinary build and development workflows only consume that
# installation.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/ci.sh" "$@"
fi

STAGE="${1:-all}"
WORK_DIR=""

cleanup() {
    if [[ -n "$WORK_DIR" ]]; then
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

require_dependencies() {
    TOOLCHAIN_ROOT="$(readlink -f "${TOOLCHAIN_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/web-ts7-vite/toolchain}")"
    if [[ ! -d "$TOOLCHAIN_ROOT" ]]; then
        echo "ERROR: the toolchain is not installed. Provision it first:" >&2
        echo "    deno task toolchain:install" >&2
        exit 1
    fi
}

# Generator-only test suites.
#
# This script also ships in generated products, where the generator's
# initialiser, toolchain management and regression suites are neither present as
# files nor defined as tasks. Each suite runs only where its source exists, so
# the same script never invokes a task a product does not have.
run_generator_only_suites() {
    if [[ -f "$PROJECT_ROOT/scripts/init-project.test.mjs" ]]; then
        echo "==> Project initialisation tests"
        deno task test:init
    fi
    if [[ -f "$PROJECT_ROOT/scripts/toolchain.test.mjs" ]]; then
        echo "==> Toolchain discovery tests"
        deno task test:toolchain
    fi
    if [[ -f "$PROJECT_ROOT/scripts/toolchain-config.test.mjs" ]]; then
        echo "==> Toolchain configuration tests"
        deno task test:toolchain-config
    fi
    if [[ -f "$PROJECT_ROOT/scripts/generate-product.test.mjs" ]]; then
        echo "==> Generator regression suite"
        deno task test:generator
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
    echo "==> Node dependency boundary (application source)"
    deno task check:node-boundary
    echo "==> Worker runtime tests"
    deno task test:worker
    echo "==> Node dependency boundary tests"
    deno task test:boundary
    echo "==> Contract lifecycle tests"
    deno task test:contracts
    echo "==> Generator-only suites"
    run_generator_only_suites
    echo "==> Vite invocation tests"
    deno task test:vite
    echo "==> Wrangler type-generation tests"
    deno task test:wrangler-types
    echo "==> Wrangler dry-run tests"
    deno task test:wrangler-dry-run
    echo "==> Node-exclusion wrapper tests"
    deno task test:no-node
    # Consumes the committed contract; it never discovers or approves one. This
    # is the last step so that a bootstrap baseline cannot hide the independent
    # suites above, and it stays fatal: in the generator repository the
    # committed contract is a provisional bootstrap baseline, so this step fails
    # by design until a person approves it — the same rule a product is held to.
    # CI must not turn that into a pass.
    echo "==> Approved toolchain contracts (no discovery)"
    deno task check:contracts
}

run_build_checks() {
    echo "==> Build and deployment tooling tests"
    deno task test:scripts
    deno task test:deploy

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
    # No application dependency tree to link: the template has no app packages.
    # The toolchain is installed outside both trees.

    cd "$WORK_DIR"

    # The template identity placeholder is not a valid Worker name, so Wrangler
    # and the Cloudflare Vite plugin refuse to run on an untouched template: the
    # generator repository must initialise its throwaway copy. A generated
    # product is already initialised and does not ship the initialiser, so the
    # same presence guard the static stage uses for generator-only suites
    # applies. Only this step is skipped; every later stage still runs.
    if [[ -f "$PROJECT_ROOT/scripts/init-project.mjs" ]]; then
        echo "==> Initialise a throwaway project identity"
        # An already initialised project is a no-op here.
        deno task init:project ci-smoke
    else
        echo "==> Project identity already initialised (no generator initialiser shipped)"
    fi

    echo "==> Generated Worker types freshness check"
    deno task check:worker-types

    echo "==> WASM build, typechecks and Vite build (Vite profile: ci-runner)"
    # Temporary override for denoland/deno#37062: Deno's sandbox blocks Vite's
    # Linux platform detection from probing special procfs paths under scoped
    # permissions, so the build fails with NotCapable. It covers both Vite
    # builds in this stage (here, and the rebuild inside deploy:dry-run below)
    # and applies only to the Vite child process on this ephemeral CI runner:
    # the launcher stays read-only, and a plain `deno task build` keeps the
    # local profile. Remove both overrides once the upstream issue is fixed and
    # the build succeeds with the restricted local profile.
    VITE_PERMISSION_PROFILE=ci-runner deno task build

    echo "==> Deployment artefact compatibility check"
    deno task check:deploy

    echo "==> WASM smoke test (build tree, Deno, Node globals hidden)"
    deno task test:wasm

    echo "==> Published-artifact smoke test (dist/client, Deno)"
    deno task test:wasm:published

    echo "==> Wrangler deployment dry run (Vite profile: ci-runner; no credentials required)"
    # deploy-dry-run.sh runs `deno task build` again, so the second CI build
    # needs the same temporary override (denoland/deno#37062); both go away
    # together once the upstream issue is fixed.
    VITE_PERMISSION_PROFILE=ci-runner deno task deploy:dry-run

    # The generated configuration is part of what the contract governs: the
    # build must not silently change compatibility settings relative to the
    # approved decision. This is the last step of the stage — after the build,
    # so the verifier can also compare dist/worker/wrangler.json — and it stays
    # fatal. Every build check above therefore runs before the verdict.
    echo "==> Generated configuration against the approved contract"
    deno task check:contracts

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
