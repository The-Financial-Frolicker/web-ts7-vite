#!/usr/bin/env bash
# Usage:
#   scripts/build.sh                    normal build
#   scripts/build.sh --print-emsdk-root  print the SDK root the build would use
#
# VITE_PERMISSION_PROFILE names the permission profile for the separate Vite
# child process: `local` (default, restricted) or `ci-runner` (`--allow-all`,
# for an ephemeral trusted CI runner). The choice is explicit and is passed to
# the launcher by name; nothing here infers it from CI or any other ambient
# variable. scripts/ci.sh sets it for its throwaway-copy build.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Direct invocation must use the same Node-exclusion contract as the Deno task.
if [[ "${DENO_NO_NODE_ACTIVE:-}" != "1" ]]; then
    exec "${BASH:-bash}" "$PROJECT_ROOT/scripts/deno-no-node.sh" \
        "${BASH:-bash}" "$PROJECT_ROOT/scripts/build.sh" "$@"
fi

# --- Initialise emsdk ONCE for the entire build process -------------------
# EMSDK_ROOT is the single source of truth for the SDK location.
#
# Resolution order (first match wins):
#   1. EMSDK_ROOT  — explicit override (e.g. a shared /opt/emsdk install)
#   2. EMSDK      — exported by mise for the pinned `emsdk` tool in .mise.toml
#   3. emcc on PATH — derive the root from <root>/upstream/emscripten/emcc
#   4. /opt/emsdk  — legacy default
resolve_emsdk_root() {
    if [[ -n "${EMSDK_ROOT:-}" ]]; then
        printf '%s\n' "$EMSDK_ROOT"
        return 0
    fi

    if [[ -n "${EMSDK:-}" ]]; then
        printf '%s\n' "$EMSDK"
        return 0
    fi

    local emcc_path=""
    local candidate=""
    if emcc_path="$(command -v emcc 2>/dev/null)" && [[ -n "$emcc_path" ]]; then
        # mise/asdf expose compilers through shims; resolve to the real binary.
        emcc_path="$(readlink -f "$emcc_path" 2>/dev/null || printf '%s' "$emcc_path")"
        # A standard emsdk layout is <root>/upstream/emscripten/emcc, so the
        # root is two directories above emcc's directory. (Going three up lands
        # on the directory that *contains* a versioned mise install, which has
        # no upstream/emscripten and would silently fall through to /opt/emsdk.)
        candidate="$(cd "$(dirname "$emcc_path")/../.." 2>/dev/null && pwd || true)"
        if [[ -n "$candidate" && -f "$candidate/upstream/emscripten/emcc" ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    fi

    printf '%s\n' "/opt/emsdk"
}

# Diagnostic mode for tests and troubleshooting: print the resolved SDK root
# without initialising the SDK or building anything.
if [[ "${1:-}" == "--print-emsdk-root" ]]; then
    resolve_emsdk_root
    exit 0
fi

EMSDK_ROOT="$(resolve_emsdk_root)"
EMSDK_ENV="$EMSDK_ROOT/emsdk_env.sh"
# Keep an unclobberable copy: emsdk_env.sh clears EMSDK_ROOT when it is sourced.
PROJECT_EMSDK_ROOT="$EMSDK_ROOT"

if [[ ! -d "$EMSDK_ROOT" ]]; then
    echo "ERROR: Emscripten SDK not found at '$EMSDK_ROOT'." >&2
    echo >&2
    echo "This project pins emsdk in .mise.toml. Install the pinned toolchain:" >&2
    echo "    mise install" >&2
    echo >&2
    echo "Alternatively point EMSDK_ROOT at an existing emsdk installation." >&2
    exit 1
fi

# --- Resolve the Python interpreter for Emscripten BEFORE sourcing emsdk ------
# Emscripten's emcc/em++ drivers are Python programs (emsdk does not bundle an
# interpreter). scripts/resolve-python.sh prefers an explicit EMSDK_PYTHON, then
# the host's python3, and only provisions one through mise when neither is
# usable. Resolve before emsdk_env.sh can alter PATH, and re-export the result
# afterwards so every compiler invocation uses the same interpreter.
if ! PYTHON_RESOLUTION="$(bash "$PROJECT_ROOT/scripts/resolve-python.sh")"; then
    echo "ERROR: could not determine a Python interpreter for Emscripten." >&2
    exit 1
fi

mapfile -t PYTHON_RESOLUTION_LINES <<<"$PYTHON_RESOLUTION"
PROJECT_PYTHON="${PYTHON_RESOLUTION_LINES[0]:-}"
PYTHON_VERSION="${PYTHON_RESOLUTION_LINES[1]:-}"
PYTHON_SOURCE="${PYTHON_RESOLUTION_LINES[2]:-}"
PYTHON_REQUIREMENT="${PYTHON_RESOLUTION_LINES[3]:-}"

if [[ -z "$PROJECT_PYTHON" || -z "$PYTHON_VERSION" ]]; then
    echo "ERROR: Python resolution returned no interpreter." >&2
    exit 1
fi

export PROJECT_PYTHON

# `source` runs in THIS shell; set -e makes any failure abort immediately.
# A mise-managed emsdk also ships emsdk_env.sh; if it is absent we rely on the
# environment mise already exported (EMSDK / EMSCRIPTEN_ROOT / EM_CONFIG / PATH).
if [[ -f "$EMSDK_ENV" ]]; then
    # shellcheck disable=SC1090
    source "$EMSDK_ENV"
else
    echo "==> emsdk_env.sh not found under $EMSDK_ROOT; using the environment provided by mise"
fi

# emsdk_env.sh unsets EMSDK_ROOT while sourcing it. Restore the value we resolved
# above so the rest of the script (and every child process) sees one consistent
# SDK location.
EMSDK_ROOT="$PROJECT_EMSDK_ROOT"
export EMSDK_ROOT

# Emscripten's compiler driver honours EMSDK_PYTHON. Re-assert the interpreter
# captured above so emsdk_env.sh cannot silently switch to a different Python.
EMSDK_PYTHON="$PROJECT_PYTHON"
export EMSDK_PYTHON

# Re-assert the Emscripten SDK root after sourcing. emsdk_env.sh may also alter
# PATH to expose its compiler tools; the build no longer requires a project Node.

# --- Validate the toolchain is usable ------------------------------------
# em++ comes from emsdk; cmake and ninja are separate mise-managed tools.
for tool in em++ cmake ninja; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required tool not on PATH after emsdk init: $tool" >&2
        echo "       Install the pinned toolchain with: mise install" >&2
        exit 1
    fi
done

# The build drives Vite through a Deno-owned launcher, Worker types through a
# Deno-owned Wrangler launcher, and typechecks through Deno's npm cache. The npm
# dependency tree is still checked for the external Vite/Wrangler/TypeScript
# packages. Deno also runs the published-artifact smoke test. Fail before the
# WASM build with the command that fixes a missing tool.
if ! command -v deno >/dev/null 2>&1; then
    echo "ERROR: Deno is required for the typechecks and the WASM smoke test," >&2
    echo "       but it is not on PATH." >&2
    echo "       Install the pinned toolchain with: mise install" >&2
    exit 1
fi
DENO_BIN="$(readlink -f "$(command -v deno)")"
if [[ -z "$DENO_BIN" || ! -x "$DENO_BIN" ]]; then
    echo "ERROR: could not resolve an executable Deno binary." >&2
    exit 1
fi

# Fail before the WASM build when the dependency tree is absent. `tsc` is still
# checked as evidence that the npm tree was installed, although the typechecks
# themselves run through Deno.
for tool in tsc vite wrangler; do
    if [[ ! -x "./node_modules/.bin/$tool" ]]; then
        echo "ERROR: npm dependencies are not installed (./node_modules/.bin/$tool is missing)." >&2
        echo "       Install them with: mise exec -- deno install --frozen" >&2
        exit 1
    fi
done
NODE_MODULES_REAL="$(readlink -f "$PROJECT_ROOT/node_modules")"
if [[ -z "$NODE_MODULES_REAL" ]]; then
    echo "ERROR: could not resolve the real node_modules directory." >&2
    exit 1
fi

# Derive the toolchain path from the SDK we resolved above. EMSDK_ROOT is
# authoritative: mise also exports EMSCRIPTEN_ROOT, which would otherwise win
# even when the caller deliberately overrides EMSDK_ROOT (e.g. to use a shared
# /opt/emsdk). Only fall back to EMSCRIPTEN_ROOT if the expected layout is absent.
EMSCRIPTEN_DIR="$EMSDK_ROOT/upstream/emscripten"
if [[ ! -d "$EMSCRIPTEN_DIR" && -n "${EMSCRIPTEN_ROOT:-}" ]]; then
    EMSCRIPTEN_DIR="$EMSCRIPTEN_ROOT"
fi
TOOLCHAIN="$EMSCRIPTEN_DIR/cmake/Modules/Platform/Emscripten.cmake"
if [[ ! -f "$TOOLCHAIN" ]]; then
    echo "ERROR: Emscripten CMake toolchain not found: $TOOLCHAIN" >&2
    exit 1
fi
export TOOLCHAIN

echo "==> [1/9] emsdk initialised (EMSDK_ROOT=$EMSDK_ROOT)"
echo "          python ${PYTHON_VERSION} ($PROJECT_PYTHON, ${PYTHON_SOURCE}; Emscripten requires >= ${PYTHON_REQUIREMENT})"
echo "          deno   $((deno --version 2>/dev/null || echo 'not found') | head -1)"
echo "          emcc   $((emcc --version 2>/dev/null || echo 'not found') | head -1)"
echo "          cmake  $((cmake --version 2>/dev/null || echo 'not found') | head -1)"
echo "          ninja  $(ninja --version 2>/dev/null || echo 'not found')"
echo "==> [2/9] Configure CMake"
bash scripts/build-wasm.sh configure
echo "==> [3/9] Build WASM (Ninja incremental)"
echo "==> [4/9] Publish build-tree WASM to public/wasm"
bash scripts/build-wasm.sh build-and-publish
# --- TypeScript checking without the project Node ---------------------------
# TypeScript 7's `tsc` npm entry point is a Node launcher for a native Go
# checker: it only resolves the platform executable and execve()s it. Running
# that launcher under Deno therefore keeps the same semantic checker, the same
# tsconfig options and the same diagnostics, while removing the project Node
# from the typecheck path. The permissions are the minimum required:
#   --allow-read   read sources and the resolved npm package
#   --allow-env    the launcher reads process.platform / process.env
#   --allow-run    spawning the native checker is the only child process. Deno
#                  accepts only an exact path for a scoped run permission, and
#                  that path is version- and platform-stamped, so this stays
#                  unrestricted. See "External ecosystem tools" in README.md.
# `--cached-only --frozen` keep the run offline and pinned to deno.lock.
typecheck() {
    deno run --allow-read --allow-env --allow-run --cached-only --frozen \
        "npm:typescript@7.0.2" -p "$1"
}

# --- Build identity ---------------------------------------------------------
# The delivered page carries the source revision and the deployment instance in
# a machine-readable element, so acceptance can prove the browser observed *this*
# build. The authoritative deployment workflow supplies both values; any other
# build records "unknown".
#
# The file is written on every build, and only when its content actually changes.
# That has two consequences that matter:
#   * a normal build leaves the committed placeholder untouched, so the working
#     tree stays clean;
#   * a build that is *not* given an identity can never inherit one from an
#     earlier identity-injected build in the same tree.
write_build_identity() {
    local sha="${1:-unknown}"
    local deployment="${2:-unknown}"
    local target="$PROJECT_ROOT/src/build-identity.ts"
    local staged
    staged="$(mktemp "${TMPDIR:-/tmp}/build-identity.XXXXXX")"

    cat > "$staged" <<IDENTITY
/**
 * Build identity for the delivered application.
 *
 * GENERATED by scripts/build.sh from BUILD_SHA and BUILD_DEPLOYMENT. Do not edit
 * this file in a release build: a build that is not given an identity records
 * "unknown" rather than reusing another deployment's provenance.
 */

export type BuildIdentity = {
  readonly sha: string;
  readonly deployment: string;
};

export const BUILD_IDENTITY: BuildIdentity = {
  sha: "${sha}",
  deployment: "${deployment}",
};
IDENTITY

    if [[ -f "$target" ]] && cmp -s "$staged" "$target"; then
        rm -f "$staged"
        echo "==> build identity: sha=$sha deployment=$deployment (unchanged)"
        return 0
    fi

    mv "$staged" "$target"
    echo "==> build identity: sha=$sha deployment=$deployment"
}

write_build_identity "${BUILD_SHA:-unknown}" "${BUILD_DEPLOYMENT:-unknown}"

echo "==> [5/9] Typecheck client"
typecheck tsconfig.json
echo "==> [6/9] Typecheck worker"
typecheck worker/tsconfig.json
echo "==> [7/9] Verify generated worker types"
bash scripts/worker-types.sh --check
echo "==> [8/9] Deno-hosted Vite build (assets + worker)"
# Remove stale build output so previous Vite layouts cannot survive.
if [[ -z "$PROJECT_ROOT" || "$PROJECT_ROOT" == "/" ]]; then
    echo "ERROR: refusing to delete dist/ with unsafe PROJECT_ROOT='$PROJECT_ROOT'" >&2
    exit 1
fi
rm -rf "$PROJECT_ROOT/dist"
# The launcher is read-only and may spawn only the pinned Deno binary. The
# separate Vite child process receives the profile this build was asked for, by
# name; the launcher rejects an unknown name instead of falling back.
VITE_PERMISSION_PROFILE="${VITE_PERMISSION_PROFILE:-local}"
deno run \
    --allow-read="$PROJECT_ROOT,$NODE_MODULES_REAL" \
    --allow-run="$DENO_BIN" \
    scripts/vite-build.mjs \
    "--permission-profile=$VITE_PERMISSION_PROFILE"
echo "==> [9/9] Test published artifact (dist/client/wasm)"
deno task test:wasm:published

echo "Full build complete."

