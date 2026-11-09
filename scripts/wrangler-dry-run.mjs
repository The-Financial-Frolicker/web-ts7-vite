/**
 * Deno-owned Wrangler dry-run launcher.
 *
 * This process does not import Wrangler and does not use the npm wrapper. It
 * resolves the installed Wrangler CLI and esbuild executable, then runs only
 * `wrangler deploy --dry-run` in a separate Deno process.
 *
 * The profile is deliberately independent of the S7.c type-generation profile:
 *   read, env, sys, write access to dist/worker and Wrangler's log directory,
 *   and run access scoped to the exact esbuild executable.
 *
 * Dry-run does not require workerd, FFI or network access. esbuild is required
 * to build the Worker bundle for the dry-run. Native esbuild is not sandboxed
 * by Deno once launched.
 */

import { join } from "./lib/path.mjs";
import { runtimePolicy } from "./lib/toolchain/runtime.mjs";
import { assertDeploymentRuntime } from "./lib/cloudflare/deployment-runtime.mjs";
import { resolveEsbuild, resolveWranglerCli } from "./wrangler-types.mjs";

function fail(message) {
  throw new Error(message);
}

/** Paths Wrangler needs to write during a dry-run. */
export function writablePaths(root = Deno.cwd()) {
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  const home = Deno.env.get("HOME");
  const configHome = xdg ??
    (home === undefined ? undefined : join(home, ".config"));

  if (configHome === undefined) {
    fail(
      "cannot determine Wrangler's config directory; set HOME or " +
        "XDG_CONFIG_HOME",
    );
  }

  return [
    join(root, "dist", "worker"),
    join(configHome, ".wrangler"),
  ];
}

/** Resolve the Wrangler CLI and the esbuild executable required by dry-run. */
export function resolveWranglerDryRunInvocation(root = Deno.cwd()) {
  return {
    wranglerCli: resolveWranglerCli(root),
    esbuild: resolveEsbuild(root),
  };
}

/**
 * Build the separate-Deno-process command line for dry-run.
 *
 * No --allow-net, --allow-ffi, workerd run permission or unrestricted run/write
 * permission is included.
 */
export function buildWranglerDryRunArgs(invocation, root, extraArgs = []) {
  const writes = writablePaths(root);
  return [
    "run",
    // The installation is provisioned by the toolchain lifecycle. Deno must use
    // that tree as-is and never set up or modify node_modules at run time.
    "--node-modules-dir=manual",
    "--allow-read",
    "--allow-env",
    "--allow-sys",
    ...writes.map((path) => `--allow-write=${path}`),
    `--allow-run=${invocation.esbuild}`,
    "--cached-only",
    "--no-lock",
    invocation.wranglerCli,
    "deploy",
    "--config",
    join(root, "dist", "worker", "wrangler.json"),
    "--dry-run",
    ...extraArgs,
  ];
}

/** Run the child Deno process and return its exit status. */
export function runChild(args, root) {
  return new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).outputSync().code;
}

/** CLI entry point; returns a process exit code. */
export function main(argv = Deno.args, root = Deno.cwd(), execute = runChild) {
  try {
    // Deno pin and installed toolchain, before any resolution or execution.
    const policy = runtimePolicy(root);

    // Deployment policy: the runtime Wrangler will execute must be the one the
    // build-side plugin graph pulled in. Checked here, at the deployment boundary,
    // and never in the toolchain certificate.
    assertDeploymentRuntime({ nodeModules: policy.generatorInstallationRoot });

    const invocation = resolveWranglerDryRunInvocation(
      policy.generatorInstallationRoot,
    );
    const extraArgs = argv[0] === "--print-profile" ? [] : argv;
    const args = buildWranglerDryRunArgs(invocation, root, extraArgs);

    if (argv[0] === "--print-profile") {
      console.log(JSON.stringify({ ...invocation, args }, null, 2));
      return 0;
    }

    console.error(
      "Wrangler dry-run: read/env/sys + two scoped write paths + " +
        `run=${invocation.esbuild}; no workerd, FFI, net or all permissions`,
    );

    return execute(args, root);
  } catch (error) {
    console.error(`Wrangler dry-run failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = main();
}
