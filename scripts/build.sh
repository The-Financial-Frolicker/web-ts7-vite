#!/usr/bin/env bash
# Usage:
#   scripts/build.sh                    normal build
#   scripts/build.sh --print-emsdk-root  print the SDK root the build would use
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

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

# --- Require the project-managed Node BEFORE sourcing emsdk --------------
# The build's TypeScript/Vite steps run through `#!/usr/bin/env node` shims and
# `node ...` commands, so a Node must be present up front. We must capture the
# project Node (e.g. mise-managed) BEFORE sourcing emsdk, and we must NOT let
# emsdk supply it: sourcing emsdk_env.sh may otherwise put Emscripten's bundled
# Node on PATH and silently become the build runtime.
NODE_REQUIRED="22.12.0"

PROJECT_NODE="$(command -v node 2>/dev/null || true)"
if [[ -z "$PROJECT_NODE" ]]; then
    echo "ERROR: no Node.js found on PATH, but the project requires its" >&2
    echo "       mise-managed Node >= ${NODE_REQUIRED} for the build." >&2
    echo >&2
    echo "Install/activate it, e.g.:" >&2
    echo "    mise install        # installs Node ${NODE_REQUIRED} (from .mise.toml)" >&2
    echo "    mise exec -- deno task build" >&2
    exit 1
fi

PROJECT_NODE_DIR="$(cd "$(dirname "$PROJECT_NODE")" && pwd)"

# Do not accept Emscripten's bundled Node as the project runtime. A reliable
# signal is whether the captured node resolves inside the emsdk tree. Compare
# against the canonicalised emsdk root so symlinked installs are handled.
if [[ -n "${EMSDK_ROOT:-}" ]]; then
    EMSDK_ROOT_REAL="$(cd "$EMSDK_ROOT" 2>/dev/null && pwd || true)"
    if [[ -n "$EMSDK_ROOT_REAL" && "$PROJECT_NODE_DIR" == "$EMSDK_ROOT_REAL"/* ]]; then
        echo "ERROR: the Node on PATH ('$PROJECT_NODE') is Emscripten's bundled Node," >&2
        echo "       not the project-managed Node. The build must not run on Emscripten's Node." >&2
        echo "       Activate the project Node (mise) before building, e.g.:" >&2
        echo "    mise exec -- deno task build" >&2
        exit 1
    fi
fi

# Validate the captured Node version (>= ${NODE_REQUIRED}) before proceeding.
NODE_VERSION="$("$PROJECT_NODE" --version 2>/dev/null || true)"
NODE_VERSION="${NODE_VERSION#v}"
if [[ ! "$NODE_VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(\+[0-9A-Za-z.-]+)?$ ]]; then
    echo "ERROR: could not parse a stable Node.js version from '$PROJECT_NODE --version' (got: '$NODE_VERSION')." >&2
    echo "       The project requires a stable Node >= ${NODE_REQUIRED} (prereleases are rejected)." >&2
    exit 1
fi
NODE_MAJOR="${BASH_REMATCH[1]}"
NODE_MINOR="${BASH_REMATCH[2]}"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 12) )); then
    echo "ERROR: the project requires Node >= ${NODE_REQUIRED}, but '$PROJECT_NODE' is ${NODE_VERSION}." >&2
    echo "       Switch to the project Node (mise), e.g.:" >&2
    echo "    mise exec -- deno task build" >&2
    exit 1
fi
export PROJECT_NODE_DIR

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

# Re-assert project Node precedence: emsdk may have prepended its own Node to
# PATH. Put the project Node directory back in front so `node` (and the
# `#!/usr/bin/env node` shims in node_modules/.bin) resolve to the managed
# runtime, while emsdk's compiler tools (em++/cmake/ninja) remain available.
if [[ -n "$PROJECT_NODE_DIR" ]]; then
    # Drop any existing occurrence of the project Node dir, then prepend it,
    # so it is unambiguously first without creating duplicate entries.
    NEW_PATH=""
    IFS=':' read -r -a _path_parts <<< "$PATH"
    for _p in "${_path_parts[@]}"; do
        [[ "$_p" == "$PROJECT_NODE_DIR" ]] && continue
        NEW_PATH="${NEW_PATH:+$NEW_PATH:}$_p"
    done
    PATH="$PROJECT_NODE_DIR:$NEW_PATH"
    export PATH
fi

# --- Validate the toolchain is usable ------------------------------------
# em++ comes from emsdk; cmake and ninja are separate mise-managed tools.
for tool in em++ cmake ninja; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required tool not on PATH after emsdk init: $tool" >&2
        echo "       Install the pinned toolchain with: mise install" >&2
        exit 1
    fi
done

# The build drives TypeScript, Vite and Wrangler through the local npm install.
# Fail before the WASM build when they are absent, with the command that fixes it.
for tool in tsc vite wrangler; do
    if [[ ! -x "./node_modules/.bin/$tool" ]]; then
        echo "ERROR: npm dependencies are not installed (./node_modules/.bin/$tool is missing)." >&2
        echo "       Install them with: mise exec -- deno install --frozen" >&2
        exit 1
    fi
done

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
echo "          node   $(node --version)"
echo "          deno   $((deno --version 2>/dev/null || echo 'not found') | head -1)"
echo "          emcc   $((emcc --version 2>/dev/null || echo 'not found') | head -1)"
echo "          cmake  $((cmake --version 2>/dev/null || echo 'not found') | head -1)"
echo "          ninja  $(ninja --version 2>/dev/null || echo 'not found')"
echo "==> [2/9] Configure CMake"
bash scripts/build-wasm.sh configure
echo "==> [3/9] Build WASM (Ninja incremental)"
echo "==> [4/9] Publish build-tree WASM to public/wasm"
bash scripts/build-wasm.sh build-and-publish
echo "==> [5/9] Typecheck client"
./node_modules/.bin/tsc
echo "==> [6/9] Typecheck worker"
./node_modules/.bin/tsc --project worker/tsconfig.json
echo "==> [7/9] Verify generated worker types"
bash scripts/worker-types.sh --check
echo "==> [8/9] ./node_modules/.bin/vite build (assets + worker)"
# Remove stale build output so previous Vite layouts cannot survive.
if [[ -z "$PROJECT_ROOT" || "$PROJECT_ROOT" == "/" ]]; then
    echo "ERROR: refusing to delete dist/ with unsafe PROJECT_ROOT='$PROJECT_ROOT'" >&2
    exit 1
fi
rm -rf "$PROJECT_ROOT/dist"
./node_modules/.bin/vite build
echo "==> [9/9] Test published artifact (dist/client/wasm)"
node scripts/test-wasm-published.mjs

echo "Full build complete."

