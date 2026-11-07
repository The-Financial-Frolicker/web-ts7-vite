/**
 * Deno-owned development and preview launcher.
 *
 * This process does not import Vite. It resolves the toolchain-owned runner, the
 * real workerd executable and the two real native bindings, then spawns one
 * Deno child with an explicit, separate profile per mode.
 *
 * Profiles (established by experiment, then narrowed where the experiment showed
 * a grant was unnecessary):
 *
 *   read                        app configuration, toolchain tree, runner
 *   write=<app>                 Vite cache, Worker state, Wrangler logs
 *   env, sys                    Vite/rolldown/Wrangler requirements
 *   net=loopback + wildcard     Vite probes port availability by binding every
 *                               wildcard host on the configured port before it
 *                               binds 127.0.0.1; the long-lived listener is
 *                               loopback-only. Reviewed exception.
 *   run=<workerd real path>     the plugin runs the Worker in workerd
 *   ffi=<rolldown>,<lightningcss>  native bindings, resolved real paths
 *
 * `esbuild` process permission is deliberately absent: development and preview
 * were shown not to need it.
 *
 * Application state is redirected into the application's ignored `.wrangler/`
 * area, so no profile writes under the user's home directory.
 */

import { join } from "./lib/path.mjs";
import { runtimePolicy } from "./lib/toolchain/runtime.mjs";
import { resolveViteInvocation } from "./vite-build.mjs";
import { resolveWorkerd } from "./wrangler-types.mjs";

/** Modes this launcher accepts, and the runner mode each one selects. */
export const VITE_SERVER_MODES = Object.freeze(["dev", "preview"]);

/** Runner modes are named for what they start, not the task that starts them. */
const RUNNER_MODES = Object.freeze({ dev: "server", preview: "preview" });

/** Explicit default ports; overridable so acceptance tests can isolate. */
export const SERVER_PORTS = Object.freeze({ dev: 5173, preview: 4173 });

const PORT_VARIABLES = Object.freeze({
  dev: "VITE_DEV_PORT",
  preview: "VITE_PREVIEW_PORT",
});

function fail(message) {
  throw new Error(message);
}

/** Port for a mode: the explicit override when set, otherwise the default. */
export function serverPort(mode, env = Deno.env) {
  if (!VITE_SERVER_MODES.includes(mode)) {
    fail(`unknown Vite server mode ${JSON.stringify(mode)}`);
  }
  const raw = env.get(PORT_VARIABLES[mode]);
  if (raw === undefined || raw === "") return SERVER_PORTS[mode];

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(
      `${PORT_VARIABLES[mode]} must be a TCP port, received ` +
        JSON.stringify(raw),
    );
  }
  return port;
}

/**
 * Application-owned runtime locations, all inside the ignored `.wrangler/` tree.
 *
 * Keeping the temporary root, the XDG configuration home and the Wrangler log
 * path here is what removes every home-directory write from the profile.
 */
export function serverStatePaths(appRoot) {
  const state = join(appRoot, ".wrangler");
  return {
    state,
    tmp: join(state, "tmp"),
    xdg: join(state, "xdg"),
    logs: join(state, "logs"),
  };
}

/** Real, resolved paths for everything the profile grants access to. */
export function resolveViteServerInvocation(toolchainRoot, appRoot) {
  const vite = resolveViteInvocation(toolchainRoot);
  return {
    runner: Deno.realPathSync(
      join(toolchainRoot, "scripts", "vite-runner.mjs"),
    ),
    appRoot: Deno.realPathSync(appRoot),
    rolldown: vite.rolldown,
    lightningcss: vite.lightningcss,
    workerd: resolveWorkerd(toolchainRoot),
  };
}

/** Build the separate-Deno-process command line for one server mode. */
export function buildViteServerArgs(invocation, mode, port) {
  if (!VITE_SERVER_MODES.includes(mode)) {
    fail(`unknown Vite server mode ${JSON.stringify(mode)}`);
  }

  return [
    "run",
    // The installation is provisioned by the toolchain lifecycle. Deno must use
    // that tree as-is and never set up or modify node_modules at run time.
    "--node-modules-dir=manual",
    "--allow-read",
    `--allow-write=${invocation.appRoot}`,
    "--allow-env",
    "--allow-sys",
    // Loopback listener plus the wildcard bind Vite's port probe performs.
    `--allow-net=127.0.0.1,localhost,0.0.0.0:${port},[::]:${port}`,
    `--allow-run=${invocation.workerd}`,
    `--allow-ffi=${invocation.rolldown}`,
    `--allow-ffi=${invocation.lightningcss}`,
    "--cached-only",
    "--no-lock",
    invocation.runner,
    RUNNER_MODES[mode],
    invocation.appRoot,
  ];
}

/** Environment for the child: redirected state plus the explicit port. */
export function serverEnv(appRoot, mode, port, env = Deno.env) {
  const paths = serverStatePaths(appRoot);
  return {
    ...env.toObject(),
    TMPDIR: paths.tmp,
    XDG_CONFIG_HOME: paths.xdg,
    WRANGLER_LOG_PATH: paths.logs,
    WRANGLER_SEND_METRICS: "false",
    [PORT_VARIABLES[mode]]: String(port),
  };
}

/** Run the child with inherited stdio and return its exit code. */
async function runChild(args, root, env) {
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  return status.code;
}

/** CLI entry point; returns an exit code. */
export async function main(
  argv = Deno.args,
  projectRoot = Deno.cwd(),
  env = Deno.env,
  execute = runChild,
) {
  const printProfile = argv.includes("--print-profile");
  const [mode] = argv.filter((argument) => argument !== "--print-profile");

  try {
    if (!VITE_SERVER_MODES.includes(mode)) {
      fail(
        `mode must be one of ${VITE_SERVER_MODES.join(", ")}, received ` +
          JSON.stringify(mode),
      );
    }

    // Deno pin and installed toolchain, before anything is resolved.
    const policy = runtimePolicy(projectRoot);

    const appRoot = Deno.realPathSync(projectRoot);
    const invocation = resolveViteServerInvocation(
      policy.toolchainRoot,
      appRoot,
    );
    const port = serverPort(mode, env);
    const args = buildViteServerArgs(invocation, mode, port);
    const childEnv = serverEnv(appRoot, mode, port, env);

    if (printProfile) {
      console.log(
        JSON.stringify(
          { mode, port, invocation, args, env: childEnv },
          null,
          2,
        ),
      );
      return 0;
    }

    console.error(
      `Vite ${mode}: read + write=${invocation.appRoot} + env/sys + ` +
        `net=127.0.0.1,localhost,0.0.0.0:${port},[::]:${port} + ` +
        `run=${invocation.workerd} + ` +
        `ffi=${invocation.rolldown},${invocation.lightningcss}; ` +
        "no esbuild run, no broad net, no all permissions",
    );

    return await execute(args, appRoot, childEnv);
  } catch (error) {
    console.error(`Vite ${mode ?? "<none>"} failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
