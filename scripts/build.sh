#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# --- Initialise emsdk ONCE for the entire build process -------------------
# EMSDK_ROOT is the single source of truth for the SDK location.
EMSDK_ROOT="${EMSDK_ROOT:-/opt/emsdk}"
EMSDK_ENV="$EMSDK_ROOT/emsdk_env.sh"

if [[ ! -f "$EMSDK_ENV" ]]; then
    echo "ERROR: emsdk environment script not found: $EMSDK_ENV" >&2
    echo "Set EMSDK_ROOT to your emsdk installation." >&2
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
# shellcheck disable=SC1090
source "$EMSDK_ENV"

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
for tool in em++ cmake ninja; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required tool not on PATH after emsdk init: $tool" >&2
        exit 1
    fi
done

# Derive the toolchain path from EMSDK_ROOT (not a separately inferred EMSDK value).
TOOLCHAIN="$EMSDK_ROOT/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake"
if [[ ! -f "$TOOLCHAIN" ]]; then
    echo "ERROR: Emscripten CMake toolchain not found: $TOOLCHAIN" >&2
    exit 1
fi
export TOOLCHAIN

echo "==> [1/9] emsdk initialised (EMSDK_ROOT=$EMSDK_ROOT)"
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

