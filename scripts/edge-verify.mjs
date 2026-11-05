/**
 * Declared permission profile for the edge-verification launcher.
 *
 * This file declares a requirement; it does not implement the launcher. The
 * edge-acceptance phase will add the run, and it must then use exactly this
 * profile. Declaring it now keeps the permission contract complete in Phase 1:
 * a launcher whose profile is not recorded cannot be reviewed for least
 * privilege, and a change to these flags becomes contract drift rather than an
 * unnoticed edit.
 *
 * Four different things are easy to conflate here, and only two of them are Deno
 * permissions this launcher needs:
 *
 *   1. Launching and controlling Chrome — `--allow-run=<chrome>`, scoped to the
 *      exact executable. Chrome's own child processes (zygote, renderers) are
 *      not gated by Deno, and no permission is needed for that.
 *   2. The local DevTools connection — `--allow-net=127.0.0.1`. Chrome is
 *      launched with `--remote-debugging-address=127.0.0.1`, and the verifier
 *      must address the endpoint as `127.0.0.1` (not `localhost`) so this
 *      loopback grant covers both the HTTP discovery call and the WebSocket.
 *   3. Chrome's own network access to the deployed Worker — *not* a Deno
 *      permission at all. The browser does that traffic, outside Deno's sandbox,
 *      which is also why Deno needs no broad `--allow-net`.
 *   4. Verifier I/O — read the authorised acceptance criteria, write the run's
 *      evidence. Both are scoped to their directories.
 *
 * Deliberately absent: `--allow-env` (the worker URL, Chrome path and artefact
 * directory arrive as arguments, and a child process inherits the environment
 * without a Deno grant), `--allow-sys` (nothing reads system information), FFI,
 * broad read, broad net and `--allow-all`. Chrome's profile directory lives
 * under the artefact directory, so no temporary-directory write grant is needed.
 */

/** Directory holding the authorised acceptance criteria (read-only input). */
export const EDGE_CRITERIA_DIR = "acceptance";

export function buildEdgeVerifyArgs(invocation, extraArgs = []) {
  return [
    "run",
    `--allow-read=${invocation.criteriaDir}`,
    `--allow-write=${invocation.artifactsDir}`,
    "--allow-net=127.0.0.1",
    `--allow-run=${invocation.chrome}`,
    "--cached-only",
    "--frozen",
    invocation.script,
    ...extraArgs,
  ];
}
