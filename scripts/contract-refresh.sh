#!/usr/bin/env bash
# Derive the toolchain contract lock. Development station only; never run in CI.
#
# The lock records facts derived from the authorised source configuration and the
# installed toolchain. This is the only path in the project that executes workerd
# and Vite, and the only operation that writes toolchain-contracts.json. Its
# output is committed and reviewed like any other source change: refresh records
# the values, a human authorises the change that produced them by reviewing it.
#
# Run it on the authorised platform (Ubuntu 24.04) with the pinned toolchain:
#   mise exec -- deno task contract:refresh
#
# Usage:
#   scripts/contract-refresh.sh                  derive and write the lock
#   scripts/contract-refresh.sh --print-workerd   print the runtime path only
#
# `--print-workerd` is the diagnostic mode used by the tests and for
# troubleshooting: it resolves and prints the runtime the probe would start,
# without deriving anything or executing a probe.
#
# Permissions are scoped to: the project and its installed dependencies (read),
# the lock file and the temporary fixture root (write), loopback (net), and the
# two executables it must start (run). No FFI, no broad net, no all-permissions.
#
# Deno's permission model gates loading and launching native code; it does not
# sandbox workerd or Vite once they run. The scoped grants limit *which* binaries
# start, not what those binaries may do afterwards.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/contract-refresh.sh" "$@"
fi

if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for contract refresh, but it is not on PATH." >&2
    exit 1
fi

DENO_BIN="$(readlink -f "$(command -v deno)")"
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
if [[ -z "$GENERATOR_ROOT" ]]; then
    echo "ERROR: the toolchain installation is not present." >&2
    echo "       Materialise it with: mise exec -- deno task toolchain:install" >&2
    exit 1
fi

TEMP_ROOT="${TMPDIR:-/tmp}"

# Resolve the runtime the Wrangler/Miniflare graph actually selects.
#
# The path is discovered, never hardcoded, and is used only to scope the run
# permission. `workerd-path` lives in the generator-only authoring CLI: the
# product CLI (cli.mjs) implements consumption commands only and has no
# derivation or refresh capability by design.
resolve_workerd() {
    local workerd
    workerd="$(
        deno run \
            --allow-read="$GENERATOR_READ_PATHS" \
            --allow-env \
            scripts/contracts/author-cli.mjs workerd-path
    )" || return 1

    if [[ -z "$workerd" || ! -x "$workerd" ]]; then
        return 1
    fi

    printf '%s\n' "$workerd"
}

if [[ "${1:-}" == "--" ]]; then
    shift
fi

if [[ "${1:-}" == "--print-workerd" ]]; then
    if ! WORKERD_PATH="$(resolve_workerd)"; then
        echo "ERROR: could not resolve an executable workerd binary from the" >&2
        echo "       installed Wrangler/Miniflare dependency graph." >&2
        exit 1
    fi
    printf '%s\n' "$WORKERD_PATH"
    exit 0
fi

if ! WORKERD="$(resolve_workerd)"; then
    echo "ERROR: could not resolve an executable workerd binary from the" >&2
    echo "       installed Wrangler/Miniflare dependency graph." >&2
    exit 1
fi

# Canonical refresh records how the WASM artefact is produced, so the authorised
# Emscripten SDK must be present. A missing SDK is a hard error: recording
# degraded provenance would make the committed lock depend on whichever machine
# ran the refresh. Read access is scoped to that exact installation below.
if [[ -z "${EMSDK:-}" || ! -d "${EMSDK:-/nonexistent}" ]]; then
    echo "ERROR: canonical contract refresh requires the authorised Emscripten SDK." >&2
    echo "       EMSDK is ${EMSDK:-not set} and does not point at an SDK directory." >&2
    echo "       Install the pinned toolchain with: mise install" >&2
    echo "       and run refresh under: mise exec -- deno task contract:refresh" >&2
    exit 1
fi

deno run \
    --allow-read="$PROJECT_ROOT,$GENERATOR_ROOT,$TEMP_ROOT,$EMSDK" \
    --allow-env \
    --allow-sys \
    --allow-write="$PROJECT_ROOT/toolchain-contracts.json,$TEMP_ROOT" \
    --allow-net=127.0.0.1 \
    --allow-run="$DENO_BIN" \
    --allow-run="$WORKERD" \
    scripts/contracts/author-cli.mjs refresh \
    "--vite-permission-profile=${VITE_PERMISSION_PROFILE:-local}" "$@"
