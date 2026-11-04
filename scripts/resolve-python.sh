#!/usr/bin/env bash
# Resolve the Python interpreter Emscripten's emcc/em++ drivers must use.
#
# Prints three lines on stdout:
#   1. absolute path to the interpreter
#   2. its version, without the "Python " prefix (for example 3.14.4)
#   3. how it was obtained: "EMSDK_PYTHON", "host python3" or "mise fallback"
#
# Resolution order, highest priority first:
#
#   1. EMSDK_PYTHON, when set. An unsuitable value is a hard error rather than a
#      silent fallback: an explicit request must never be quietly replaced.
#   2. python3 on PATH. The `python` name is deliberately not consulted: it is
#      optional, often absent, and sometimes aliased.
#   3. mise, which provisions PYTHON_FALLBACK_VERSION. This is the only path that
#      installs anything, and it runs only when steps 1 and 2 cannot supply a
#      usable interpreter.
#
# Ownership: Emscripten owns the requirement (emcc.py asserts Python >= 3.10),
# the host normally supplies the interpreter, and this project only provisions
# one when the host cannot. The caller exports the result as EMSDK_PYTHON, which
# is how Emscripten learns about it.
set -euo pipefail

die() {
    printf '%s\n' "$@" >&2
    exit 1
}

# --- Discover the requirement from the installed SDK ---------------------------
# The SDK owns the requirement, so it is read from the SDK rather than kept as a
# project constant. emcc.py asserts it directly:
#   assert sys.version_info >= (3, 10), 'emscripten requires python 3.10 or above'
# A wrong or missing assertion is a hard error: guessing a minimum here would
# silently accept an interpreter Emscripten will refuse.
discover_emsdk_root() {
    if [[ -n "${EMSDK_ROOT:-}" ]]; then
        printf '%s\n' "$EMSDK_ROOT"
        return 0
    fi
    local emcc
    emcc="$(command -v emcc 2>/dev/null || true)"
    if [[ -n "$emcc" ]]; then
        # <root>/upstream/emscripten/emcc -> <root>
        printf '%s\n' "$(cd "$(dirname "$(readlink -f "$emcc")")/../.." && pwd)"
        return 0
    fi
    return 1
}

discover_python_requirement() {
    local root emcc_py text major minor
    if ! root="$(discover_emsdk_root)"; then
        die \
            "ERROR: cannot locate the Emscripten SDK, so its Python requirement is unknown." \
            "       Set EMSDK_ROOT, or put emcc on PATH."
    fi

    emcc_py="$root/upstream/emscripten/emcc.py"
    if [[ ! -f "$emcc_py" ]]; then
        die \
            "ERROR: '$emcc_py' is missing, so Emscripten's Python requirement cannot be read." \
            "       Reinstall the pinned emsdk (mise install), or set EMSDK_ROOT correctly."
    fi

    text="$(<"$emcc_py")"
    local pattern='sys\.version_info[[:space:]]*>=[[:space:]]*\([[:space:]]*([0-9]+)[[:space:]]*,[[:space:]]*([0-9]+)'
    if [[ ! $text =~ $pattern ]]; then
        die \
            "ERROR: could not find a 'sys.version_info >= (X, Y)' assertion in '$emcc_py'." \
            "       The SDK layout may have changed. Refusing to guess Emscripten's Python minimum."
    fi

    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
    printf '%s.%s\n' "$major" "$minor"
}

PYTHON_REQUIREMENT="$(discover_python_requirement)"
PYTHON_MIN_MAJOR="${PYTHON_REQUIREMENT%%.*}"
PYTHON_MIN_MINOR="${PYTHON_REQUIREMENT##*.}"
# The fallback is the requirement itself, so an SDK upgrade that raises the
# minimum also raises what gets provisioned. Nothing here is pinned by hand.
PYTHON_FALLBACK_VERSION="${PYTHON_FALLBACK_VERSION:-$PYTHON_REQUIREMENT}"

# Parse "Python X.Y.Z" into PY_MAJOR, PY_MINOR and PY_VERSION; fails when the
# text is not a Python version.
parse_version() {
    local text="$1"
    if [[ ! $text =~ ^Python[[:space:]]+([0-9]+)\.([0-9]+)(\.[0-9]+)? ]]; then
        return 1
    fi
    PY_MAJOR="${BASH_REMATCH[1]}"
    PY_MINOR="${BASH_REMATCH[2]}"
    PY_VERSION="${PY_MAJOR}.${PY_MINOR}${BASH_REMATCH[3]}"
}

# True when major.minor satisfies Emscripten's minimum.
is_supported() {
    local major="$1" minor="$2"
    (( major >= PYTHON_MIN_MAJOR )) || return 1
    (( major > PYTHON_MIN_MAJOR || minor >= PYTHON_MIN_MINOR ))
}

# Print the interpreter's version text, or nothing when it cannot be run.
version_text() {
    local candidate="$1" text
    text="$("$candidate" --version 2>&1 | head -n 1 || true)"
    printf '%s\n' "$text"
}

# Emit the result: path, version, source, and the requirement it was checked
# against (so callers can report a discovered contract, not a constant).
report() {
    printf '%s\n%s\n%s\n%s\n' "$1" "$2" "$3" "$PYTHON_REQUIREMENT"
}

# --- 1. Explicit EMSDK_PYTHON -------------------------------------------------
if [[ -n "${EMSDK_PYTHON:-}" ]]; then
    if [[ ! -e "$EMSDK_PYTHON" ]]; then
        die \
            "ERROR: EMSDK_PYTHON is set to '$EMSDK_PYTHON', which does not exist." \
            "       Fix the path, or unset EMSDK_PYTHON to let the project resolve one."
    fi
    if [[ ! -x "$EMSDK_PYTHON" ]]; then
        die \
            "ERROR: EMSDK_PYTHON is set to '$EMSDK_PYTHON', which is not executable." \
            "       Fix the path, or unset EMSDK_PYTHON to let the project resolve one."
    fi

    explicit_path="$(readlink -f "$EMSDK_PYTHON")"
    explicit_text="$(version_text "$explicit_path")"
    if ! parse_version "$explicit_text"; then
        die \
            "ERROR: EMSDK_PYTHON='$EMSDK_PYTHON' is not a Python 3 interpreter" \
            "       (version output: '${explicit_text:-none}')." \
            "       Emscripten requires Python ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR} or newer."
    fi
    if ! is_supported "$PY_MAJOR" "$PY_MINOR"; then
        die \
            "ERROR: EMSDK_PYTHON='$EMSDK_PYTHON' is Python ${PY_VERSION}, but" \
            "       Emscripten requires Python ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR} or newer." \
            "       Point EMSDK_PYTHON at a newer interpreter, or unset it so the project" \
            "       can resolve one."
    fi

    report "$explicit_path" "$PY_VERSION" "EMSDK_PYTHON"
    exit 0
fi

# --- 2. Host python3 ------------------------------------------------------------
# PATH can contain a python3 that is not a working interpreter — mise installs a
# shim for tools it has not installed, and that shim answers with a hint instead
# of a version. Scan PATH in order and take the first candidate that actually
# reports a supported version, so a shadowing shim cannot hide a real host
# Python further along PATH.
HOST_PATH=""
HOST_VERSION=""
HOST_NOTES=()

IFS=: read -r -a PATH_ENTRIES <<<"${PATH:-}"
for entry in "${PATH_ENTRIES[@]}"; do
    candidate="${entry%/}/python3"
    [[ -x "$candidate" ]] || continue

    resolved="$(readlink -f "$candidate")"
    text="$(version_text "$resolved")"
    if ! parse_version "$text"; then
        HOST_NOTES+=("$candidate did not report a Python version (got: '${text:-none}')")
        continue
    fi
    if is_supported "$PY_MAJOR" "$PY_MINOR"; then
        HOST_PATH="$resolved"
        HOST_VERSION="$PY_VERSION"
        break
    fi
    HOST_NOTES+=(
        "$candidate is Python ${PY_VERSION}, but Emscripten requires ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR} or newer"
    )
done

if [[ -n "$HOST_PATH" ]]; then
    report "$HOST_PATH" "$HOST_VERSION" "host python3"
    exit 0
fi

if (( ${#HOST_NOTES[@]} == 0 )); then
    HOST_REJECTION="no python3 was found on PATH."
else
    joined=""
    for note in "${HOST_NOTES[@]}"; do
        if [[ -z "$joined" ]]; then
            joined="$note"
        else
            joined="$joined; $note"
        fi
    done
    HOST_REJECTION="no usable python3 was found on PATH: $joined"
fi

# --- 3. mise fallback -----------------------------------------------------------
if ! command -v mise >/dev/null 2>&1; then
    die \
        "ERROR: $HOST_REJECTION" \
        "       mise is not installed, so no fallback Python can be provisioned." \
        "       Install Python ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}+ for the host (recommended), or install mise:" \
        "    https://mise.jdx.dev/getting-started.html"
fi

printf 'Python for Emscripten: %s\n' "$HOST_REJECTION" >&2
printf 'Provisioning Python %s with mise (fallback).\n' "$PYTHON_FALLBACK_VERSION" >&2

if ! mise install "python@$PYTHON_FALLBACK_VERSION" >&2; then
    die \
        "ERROR: 'mise install python@${PYTHON_FALLBACK_VERSION}' failed." \
        "       Install Python ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}+ for the host, or retry:" \
        "    mise install python@${PYTHON_FALLBACK_VERSION}"
fi

if ! FALLBACK_PYTHON="$(mise which --tool "python@$PYTHON_FALLBACK_VERSION" python3 2>/dev/null)"; then
    die \
        "ERROR: mise provisioned python@${PYTHON_FALLBACK_VERSION} but could not resolve its python3 executable." \
        "       Check it with:" \
        "    mise which --tool python@${PYTHON_FALLBACK_VERSION} python3"
fi

FALLBACK_PATH="$(readlink -f "$FALLBACK_PYTHON")"
FALLBACK_TEXT="$(version_text "$FALLBACK_PATH")"
if ! parse_version "$FALLBACK_TEXT"; then
    die \
        "ERROR: the mise-provisioned interpreter '$FALLBACK_PATH' did not report a Python version" \
        "       (got: '${FALLBACK_TEXT:-none}')."
fi
if ! is_supported "$PY_MAJOR" "$PY_MINOR"; then
    die \
        "ERROR: the mise-provisioned interpreter is Python ${PY_VERSION}, but" \
        "       Emscripten requires Python ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR} or newer."
fi

report "$FALLBACK_PATH" "$PY_VERSION" "mise fallback"
