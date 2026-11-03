#!/usr/bin/env bash
# Execute a project-owned command with a PATH tripwire that rejects `node`.
#
# This is a command-name exclusion, not an OS process sandbox. It catches
# scripts, shebangs and commands that resolve `node`/`nodejs` through PATH. An
# absolute path such as /usr/bin/node is outside its reach, as is a child that
# deliberately replaces PATH.
#
# The wrapper changes PATH only for the supplied command's process tree; it does
# not modify the caller's shell or exported environment.
set -u

if (( $# == 0 )); then
    echo "Usage: scripts/deno-no-node.sh <command> [arguments...]" >&2
    exit 2
fi

# Already inside the tripwire: run the command directly instead of nesting a
# second one. Tasks composed of other wrapped tasks therefore stay one tripwire
# deep, and the marker stays a recursion guard rather than a security token — a
# caller that sets it skips the wrapper, so it is not unforgeable.
if [[ "${DENO_NO_NODE_ACTIVE:-}" == "1" ]]; then
    exec "$@"
fi

TRIPWIRE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/deno-no-node.XXXXXX")" || {
    echo "ERROR: cannot create the Node-exclusion tripwire directory." >&2
    exit 1
}

cleanup() {
    rm -rf "$TRIPWIRE_DIR"
}
trap cleanup EXIT HUP INT TERM

for name in node nodejs; do
    # shellcheck disable=SC2016 # $0/$* must be expanded by the shim, not here.
    printf '%s\n' \
        '#!/bin/sh' \
        'printf "ERROR: Node.js is excluded from project-owned execution; attempted %s\\n" "'"$name"' $*" >&2' \
        'exit 127' >"$TRIPWIRE_DIR/$name"
    chmod +x "$TRIPWIRE_DIR/$name"
done

PATH="$TRIPWIRE_DIR${PATH:+:$PATH}"
export PATH
export DENO_NO_NODE_ACTIVE=1

"$@"
status=$?
exit "$status"
