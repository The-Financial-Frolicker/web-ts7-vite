#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Environment (emsdk, PATH, EMSDK, TOOLCHAIN) is inherited from scripts/build.sh.
# This script does NOT initialise emsdk itself.
: "${TOOLCHAIN:?TOOLCHAIN must be set by scripts/build.sh}"

BUILD_DIR="build-wasm"
PUBLISH_DIR="public/wasm"
JS_SRC="$BUILD_DIR/wasm_math.js"
WASM_SRC="$BUILD_DIR/wasm_math.wasm"

configure() {
    cmake -S wasm -B "$BUILD_DIR" -G Ninja -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN"
}

build_and_publish() {
    # Incremental build; Ninja tracks dependencies.
    cmake --build "$BUILD_DIR"

    # Pre-copy validation: build-tree outputs must exist and be non-empty.
    for f in "$JS_SRC" "$WASM_SRC"; do
        if [[ ! -s "$f" ]]; then
            echo "ERROR: build-tree artifact missing or empty: $f" >&2
            exit 1
        fi
    done

    # Deterministic publication on EVERY invocation (not dependent on POST_BUILD).
    mkdir -p "$PUBLISH_DIR"
    cp -f "$JS_SRC"   "$PUBLISH_DIR/wasm_math.js"
    cp -f "$WASM_SRC" "$PUBLISH_DIR/wasm_math.wasm"

    # Post-copy validation: published files must exist and be non-empty.
    for f in "$PUBLISH_DIR/wasm_math.js" "$PUBLISH_DIR/wasm_math.wasm"; do
        if [[ ! -s "$f" ]]; then
            echo "ERROR: published artifact missing or empty: $f" >&2
            exit 1
        fi
    done
    echo "Published build-tree WASM to $PUBLISH_DIR/"
}

case "${1:-}" in
    configure)         configure ;;
    build-and-publish) build_and_publish ;;
    "")
        # Allow standalone use, but it then requires an emsdk-initialised shell.
        echo "ERROR: run via scripts/build.sh, or pass: configure | build-and-publish" >&2
        echo "       (this script does not initialise emsdk itself)" >&2
        exit 1 ;;
    *)
        echo "ERROR: unknown subcommand: $1" >&2; exit 1 ;;
esac
