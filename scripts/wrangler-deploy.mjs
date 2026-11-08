/**
 * Deno-owned Wrangler deployment launcher.
 *
 * This process does not import Wrangler. It resolves the installed Wrangler CLI
 * and the real esbuild executable, then runs one Deno child with an explicit
 * profile:
 *
 *   read, env, sys,
 *   write=<app>/.wrangler      Worker state and the Wrangler debug log
 *   run=<esbuild real path>    Wrangler bundles the Worker with it
 *   net=api.cloudflare.com     the only endpoint the deploy path needs
 *
 * Deliberately absent: write access to `dist/worker` (deployment does not write
 * there — established by removing the grant and observing the deploy still
 * reach the API), broad network access and broad process execution.
 *
 * Arguments are passed to Wrangler verbatim, so the same launcher and profile
 * serve `deploy` and read-only queries such as
 * `deployments status --name <worker> --json`.
 *
 * `TMPDIR`, `XDG_CONFIG_HOME` and `WRANGLER_LOG_PATH` are redirected into the
 * application's ignored `.wrangler/` area: no profile writes under the home
 * directory, and no permission is widened to silence a warning.
 */

import { join } from "./lib/path.mjs";
import { runtimePolicy } from "./lib/toolchain/runtime.mjs";
import { resolveEsbuild, resolveWranglerCli } from "./wrangler-types.mjs";

/** The only host the deployment path is granted. */
export const DEPLOY_NETWORK = "api.cloudflare.com";

/** Application-owned deployment state, inside the ignored `.wrangler/` tree. */
export function deployStatePaths(appRoot) {
  const state = join(appRoot, ".wrangler");
  return {
    state,
    tmp: join(state, "tmp"),
    xdg: join(state, "xdg"),
    logs: join(state, "logs"),
    // Wrangler resolves its temporary state relative to the directory of the
    // `--config` file it was given, which for the generated deployment config is
    // `<app>/dist/worker`. This grant is therefore exactly Wrangler's own hidden
    // state directory — never the build output beside it. Granting the whole
    // `dist/worker` would be broader than the requirement.
    configState: join(appRoot, "dist", "worker", ".wrangler"),
  };
}

/** Real, resolved paths for the profile and the default invocation. */
export function resolveWranglerDeployInvocation(
  generatorInstallationRoot,
  appRoot,
) {
  return {
    wranglerCli: resolveWranglerCli(generatorInstallationRoot),
    esbuild: resolveEsbuild(generatorInstallationRoot),
    appRoot: Deno.realPathSync(appRoot),
    config: join(Deno.realPathSync(appRoot), "dist", "worker", "wrangler.json"),
  };
}

/** Build the separate-Deno-process command line. */
export function buildWranglerDeployArgs(invocation, extraArgs = []) {
  const paths = deployStatePaths(invocation.appRoot);
  const writes = [paths.state, paths.configState];

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
    `--allow-net=${DEPLOY_NETWORK}`,
    "--cached-only",
    "--no-lock",
    invocation.wranglerCli,
    ...(extraArgs.length === 0
      ? ["deploy", "--config", invocation.config]
      : extraArgs),
  ];
}

/** Environment for the child: redirected state, no metrics, no home writes. */
export function deployEnv(appRoot, env = Deno.env) {
  const paths = deployStatePaths(appRoot);
  return {
    ...env.toObject(),
    TMPDIR: paths.tmp,
    XDG_CONFIG_HOME: paths.xdg,
    WRANGLER_LOG_PATH: paths.logs,
    WRANGLER_SEND_METRICS: "false",
  };
}

/** Run the child with inherited stdio and return its exit code. */
function runChild(args, root, env) {
  const result = new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).outputSync();
  return result.code;
}

/** CLI entry point; returns an exit code. */
export function main(
  argv = Deno.args,
  projectRoot = Deno.cwd(),
  env = Deno.env,
  execute = runChild,
) {
  const printProfile = argv.includes("--print-profile");
  const extraArgs = argv.filter((argument) => argument !== "--print-profile");

  try {
    const policy = runtimePolicy(projectRoot);

    const appRoot = Deno.realPathSync(projectRoot);
    const invocation = resolveWranglerDeployInvocation(
      policy.generatorInstallationRoot,
      appRoot,
    );
    const args = buildWranglerDeployArgs(invocation, extraArgs);
    const childEnv = deployEnv(appRoot, env);

    if (printProfile) {
      console.log(JSON.stringify({ invocation, args, env: childEnv }, null, 2));
      return 0;
    }

    console.error(
      `Wrangler deploy: read/env/sys + write=${invocation.appRoot}/.wrangler and ` +
        `${invocation.appRoot}/dist/worker/.wrangler + ` +
        `run=${invocation.esbuild} + net=${DEPLOY_NETWORK}; ` +
        "no broad dist write, no broad net, no broad run",
    );

    return execute(args, appRoot, childEnv);
  } catch (error) {
    console.error(`Wrangler deploy failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = main();
}
