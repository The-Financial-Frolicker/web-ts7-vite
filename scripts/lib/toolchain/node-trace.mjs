/**
 * Process-execution evidence for the No-Node guarantee.
 *
 * The PATH tripwire (`scripts/deno-no-node.sh`) can only refuse a `node` resolved
 * through `PATH`. This helper adds evidence at the process boundary: it traces
 * `execve`/`execveat` across a command's process tree and classifies what
 * actually executed.
 *
 * The guarantee it serves is narrow: **no Node runtime may execute as the host
 * for the protected web toolchain**. Therefore:
 *
 *   * classification is by **resolved executable path**, never by `argv[0]` — the
 *     tripwire shim is a shell script whose argv says `node`;
 *   * a failed lookup (`= -1 ENOENT`) never started a process;
 *   * Deno's `node:` compatibility layer is not a process;
 *   * exactly one Node runtime is permitted: the binary bundled with the pinned
 *     Emscripten SDK, bound to its canonical path inside the mise installation.
 *
 * This is detection, not prevention: the tracer observes executions that have
 * already happened.
 */

import path from "../path.mjs";
import { mkdirSync, rmSync } from "../fs.mjs";

export class NodeTraceError extends Error {
  constructor(message) {
    super(message);
    this.name = "NodeTraceError";
  }
}

/** mise's data directory, following mise's own resolution order. */
export function miseDataDirectory(env = Deno.env) {
  const explicit = env.get("MISE_DATA_DIR");
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const xdg = env.get("XDG_DATA_HOME");
  if (xdg !== undefined && xdg.length > 0) return path.join(xdg, "mise");
  const home = env.get("HOME");
  if (home === undefined || home.length === 0) {
    throw new NodeTraceError("no MISE_DATA_DIR, XDG_DATA_HOME or HOME");
  }
  return path.join(home, ".local", "share", "mise");
}

/**
 * The one permitted Node runtime: the pinned Emscripten SDK's bundled binary.
 *
 * Derived from the mise-managed installation (never a hard-coded home path) and
 * returned canonically. Ambiguity — several SDK versions or several bundled Node
 * builds — is an error rather than a guess, so the exception cannot widen.
 */
export function pinnedEmsdkVersion(projectRoot = Deno.cwd()) {
  let text;
  try {
    text = Deno.readTextFileSync(path.join(projectRoot, ".mise.toml"));
  } catch {
    return null;
  }
  let inTools = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inTools = line === "[tools]";
      continue;
    }
    if (!inTools) continue;
    const entry = /^emsdk\s*=\s*"([^"]+)"$/.exec(line);
    if (entry !== null) return entry[1];
  }
  return null;
}

export function permittedEmscriptenNode(
  env = Deno.env,
  { projectRoot = Deno.cwd() } = {},
) {
  // Bound to the *pinned* SDK version, so a second SDK installed on the machine
  // can neither widen the exception nor make it ambiguous.
  const pinned = pinnedEmsdkVersion(projectRoot);
  if (pinned === null) return null;

  const installs = path.join(miseDataDirectory(env), "installs", "emsdk");
  const found = [];
  const versions = [pinned];

  for (const version of versions) {
    const nodeRoot = path.join(installs, version, "node");
    let builds = [];
    try {
      builds = [...Deno.readDirSync(nodeRoot)]
        .filter((entry) => entry.isDirectory)
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const build of builds) {
      const candidate = path.join(nodeRoot, build, "bin", "node");
      try {
        if (Deno.statSync(candidate).isFile) {
          found.push(Deno.realPathSync(candidate));
        }
      } catch {
        // Not this build.
      }
    }
  }

  if (found.length === 0) return null;
  if (found.length > 1) {
    throw new NodeTraceError(
      `refusing to guess which Emscripten Node is the permitted runtime: ` +
        `${found.join(", ")}`,
    );
  }
  return found[0];
}

/** Is this executable a Node runtime by name alone? */
export function looksLikeNode(executable) {
  const base = path.basename(executable);
  return base === "node" || base === "nodejs" || base === "node.exe";
}

/**
 * Successful and failed executions recorded in a trace, in order.
 *
 * Each entry is `{ path, argv, ok }`. The first quoted argument is the executable
 * path (`execveat` leads with a numeric descriptor, which the parser ignores).
 */
export function parseExecutions(traceText) {
  const executions = [];

  for (const line of traceText.split("\n")) {
    if (!/execve(at)?\(/.test(line)) continue;

    const quoted = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
      match[1]
    );
    if (quoted.length === 0) continue;

    executions.push({
      path: quoted[0],
      argv: quoted.slice(1),
      ok: /\)\s*=\s*0\s*$/.test(line),
    });
  }

  return executions;
}

/**
 * Classify one execution against the guarantee.
 *
 * `"permitted-emscripten"`, `"tripwire-shim"`, `"node"` (a violation) or
 * `"other"`. Failed attempts and non-Node executables are `"other"`.
 */
export function classifyExecution(execution, { permitted = null } = {}) {
  if (!execution.ok) return "other";
  if (!looksLikeNode(execution.path)) return "other";

  // The tripwire writes its shims into a `deno-no-node.XXXXXX` temp directory;
  // the shim is a shell script, not a Node runtime.
  if (/\/deno-no-node\.[^/]+\//.test(execution.path)) return "tripwire-shim";

  let canonical = execution.path;
  try {
    canonical = Deno.realPathSync(execution.path);
  } catch {
    // Classify by what the path says.
  }

  if (permitted !== null && canonical === permitted) {
    return "permitted-emscripten";
  }
  return "node";
}

/** Every prohibited Node execution in a trace. */
export function prohibitedExecutions(traceText, { permitted = null } = {}) {
  return parseExecutions(traceText)
    .filter((execution) =>
      classifyExecution(execution, { permitted }) === "node"
    );
}

/** Describe a violation for test output. */
export function formatViolation(execution) {
  return `Node runtime executed as host: ${execution.path} ` +
    `(argv: ${JSON.stringify(execution.argv.slice(0, 3))})`;
}

/** Is `strace` usable here? Reported, never assumed. */
export function straceAvailable() {
  try {
    return new Deno.Command("strace", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync().code === 0;
  } catch {
    return false;
  }
}

/**
 * Trace one command's process tree and return the trace text.
 *
 * `strace` is a local diagnostic capability, not a project dependency: when it is
 * absent the caller must report the assertion as *not performed* rather than
 * treating the PATH tripwire as equivalent evidence.
 */
export function traceCommand(
  command,
  { cwd = Deno.cwd(), env = undefined } = {},
) {
  const directory = Deno.makeTempDirSync({ prefix: "no-node-trace-" });
  const traceFile = path.join(directory, "trace.txt");

  try {
    const result = new Deno.Command("strace", {
      args: ["-f", "-e", "trace=execve,execveat", "-o", traceFile, ...command],
      cwd,
      ...(env === undefined ? {} : { env }),
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).outputSync();

    let trace = "";
    try {
      trace = Deno.readTextFileSync(traceFile);
    } catch {
      mkdirSync(directory, { recursive: true });
    }

    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      trace,
    };
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort: the trace lives under /tmp.
    }
  }
}
