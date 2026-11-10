/**
 * Self-contained deployment validation (generator side).
 *
 * Establishes an initialised application identity in an isolated workspace,
 * builds it, packs a real hand-off and qualifies the deployment against it:
 *
 *   1. the generator checkout keeps its template identity — it is never
 *      converted into an application and is never built in place;
 *   2. `toolchain:install` installs or re-establishes the mise-owned build
 *      toolchain, which the isolated build reuses;
 *   3. `scripts/ci.sh build` runs the established copy-and-initialise routine:
 *      it copies the checkout (without `generator/` or `application/`), gives the
 *      copy a throwaway identity, builds, checks the deployment artefacts and
 *      packs the hand-off. The workspace is owned here, so it exists before the
 *      step and is removed even when the step fails;
 *   4. `deployment:install` installs the deployment dependency closure inside
 *      that workspace, so the copy owns the tree its qualification resolves;
 *   5. `deployment:qualify` runs in the workspace against the hand-off: the
 *      deployment suites, hand-off verification, deployment-artefact
 *      compatibility and the Wrangler dry run. It never uploads.
 *
 * Nothing is deployed, no generator-owned tree outside `generator/toolchain` is
 * touched, and the generator identity is compared before and after.
 */

import { inspectProject } from "./init-project.mjs";
import { basename } from "./lib/path.mjs";
import { executeStep } from "./lib/validation/steps.mjs";
import { assertGeneratorIdentity } from "./validate-toolchain.mjs";

/** Prefix of every workspace the established copy routine uses. */
export const WORKSPACE_PREFIX = "web-ts7-vite-ci.";

export class DeploymentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentValidationError";
  }
}

function fail(message) {
  throw new DeploymentValidationError(message);
}

/**
 * Create the workspace this orchestrator owns and `scripts/ci.sh` copies into.
 *
 * Synchronous on purpose: the directory must exist before the step that copies
 * into it starts, and ownership stays with the caller who created it.
 */
export function createWorkspace(env = Deno.env.toObject()) {
  const parent = env.RUNNER_TEMP || env.TMPDIR || "/tmp";
  return Deno.makeTempDirSync({ dir: parent, prefix: WORKSPACE_PREFIX });
}

/**
 * The build step: the established copy/initialise/build routine, writing into
 * the workspace the caller created and packing the hand-off inside it. The
 * copy reuses the generator checkout's toolchain, which `scripts/ci.sh` names
 * itself from the checkout it runs in.
 */
export function buildHandoffStep({ root, workspace, env = {} }) {
  return {
    name: "build and pack the hand-off in an isolated workspace",
    command: "bash",
    args: ["scripts/ci.sh", "build"],
    cwd: root,
    env: {
      ...env,
      CI_WORK_DIR: workspace,
      CI_PACK_HANDOFF: "1",
    },
  };
}

/**
 * The deployment closure is installed into the workspace, by the existing
 * installer, so the copied project owns the tree its qualification resolves.
 * Nothing is installed into, or borrowed from, the generator checkout, and no
 * root override is in play while the deployment suites run.
 */
export function deploymentInstallStep({ workspace, env = {} }) {
  return {
    name: "install the deployment dependency closure in the workspace",
    command: Deno.execPath(),
    args: ["task", "deployment:install", "--", "--allow-download"],
    cwd: workspace,
    env,
  };
}

/** The qualification step: runs in the workspace against its own closures. */
export function deploymentQualifyStep({ workspace, env = {} }) {
  return {
    name: "qualify the deployment against the hand-off",
    command: Deno.execPath(),
    args: ["task", "deployment:qualify"],
    cwd: workspace,
    env,
  };
}

/**
 * Remove a workspace, refusing anything that is not one of the established
 * copies: a wrong path must never turn into a recursive delete.
 */
export function removeWorkspace(workspace, io = console) {
  if (!basename(workspace).startsWith(WORKSPACE_PREFIX)) {
    io.error(
      `refusing to remove ${workspace}: it is not a ${WORKSPACE_PREFIX}* workspace`,
    );
    return false;
  }
  try {
    Deno.removeSync(workspace, { recursive: true });
    return true;
  } catch {
    // Already gone: the routine is repeatable.
    return false;
  }
}

/** CLI entry point; returns an exit code. */
export function main(argv = Deno.args, options = {}) {
  const {
    root = Deno.cwd(),
    env = Deno.env.toObject(),
    io = console,
    run,
    inspect = inspectProject,
    create = createWorkspace,
    remove = removeWorkspace,
  } = options;

  if (argv.length > 0) {
    io.error("usage: validate-deployment.mjs (takes no arguments)");
    return 2;
  }

  let workspace;
  try {
    const before = assertGeneratorIdentity(root, inspect);

    executeStep({
      name: "install or re-establish the mise-owned toolchain",
      command: Deno.execPath(),
      args: ["task", "toolchain:install"],
      cwd: root,
      env,
    }, { run, io });

    workspace = create(env);
    executeStep(buildHandoffStep({ root, workspace, env }), { run, io });
    executeStep(deploymentInstallStep({ workspace, env }), { run, io });
    executeStep(deploymentQualifyStep({ workspace, env }), { run, io });

    // The generator checkout is used, never converted: its identity must be the
    // one validation started from.
    const after = assertGeneratorIdentity(root, inspect);
    if (JSON.stringify(after.identity) !== JSON.stringify(before.identity)) {
      fail(
        "the generator checkout's identity changed during deployment validation",
      );
    }

    io.log("deployment validation complete");
    return 0;
  } catch (error) {
    io.error(`deployment validation failed: ${error.message}`);
    return 1;
  } finally {
    if (workspace !== undefined) remove(workspace, io);
  }
}

if (import.meta.main) {
  Deno.exitCode = main();
}
