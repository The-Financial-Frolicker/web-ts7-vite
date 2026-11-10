/**
 * Self-contained toolchain validation (generator side).
 *
 * Establishes the state its own qualification needs, then qualifies it:
 *
 *   1. the generator/template identity is intact — the generator suites assert
 *      the template's identity, so an initialised application identity is
 *      refused here rather than left to fail later;
 *   2. `toolchain:install` installs, or re-establishes, the mise-owned toolchain
 *      and writes its identity record, which is what creates the resolution view;
 *   3. `check:contracts` compares the installed toolchain with the committed
 *      contract lock. It is a verdict, never a refresh: regenerating the lock is
 *      `deno task contract:refresh`, an explicit authoring operation;
 *   4. `toolchain:qualify` runs the complete generator qualification path.
 *
 * Deployment state is out of scope: the deployment installation record is read
 * before and after, and any change is a failure. Nothing is deployed.
 */

import { inspectProject } from "./init-project.mjs";
import { join } from "./lib/path.mjs";
import { executePlan } from "./lib/validation/steps.mjs";
import { fileDigest } from "./lib/toolchain/tree-digest.mjs";

export const DEPLOYMENT_RECORD = "deployment.json";

export class ToolchainValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolchainValidationError";
  }
}

function fail(message) {
  throw new ToolchainValidationError(message);
}

/**
 * Refuse to validate a checkout whose template identity has been replaced.
 *
 * The rule and its diagnostics stay in the initialiser: this asks that operation
 * what state the checkout is in rather than re-deriving it from package.json.
 */
export function assertGeneratorIdentity(root, inspect = inspectProject) {
  const inspection = inspect(root);
  if (inspection.state !== "template") {
    fail(
      `${root} is not a generator template (state: ${inspection.state}). ` +
        `Toolchain validation qualifies the template identity; run it in a ` +
        `clean checkout rather than in an initialised application.`,
    );
  }
  return inspection;
}

/** The exact operations, in order, that toolchain validation performs. */
export function toolchainValidationSteps({ root, runtime = Deno.execPath() }) {
  return [
    {
      name: "install or re-establish the mise-owned toolchain",
      command: runtime,
      args: ["task", "toolchain:install"],
      cwd: root,
    },
    {
      name: "verify the installed toolchain against the committed contract",
      command: runtime,
      args: ["task", "check:contracts"],
      cwd: root,
    },
    {
      name: "run the complete toolchain qualification path",
      command: runtime,
      args: ["task", "toolchain:qualify"],
      cwd: root,
    },
  ];
}

/** Digest of the deployment installation record, or undefined when absent. */
export async function deploymentRecordDigest(root) {
  try {
    return await fileDigest(
      join(root, "generator", "deployment", DEPLOYMENT_RECORD),
    );
  } catch {
    return undefined;
  }
}

/** CLI entry point; returns an exit code. */
export async function main(argv = Deno.args, options = {}) {
  const {
    root = Deno.cwd(),
    io = console,
    run,
    inspect = inspectProject,
  } = options;

  if (argv.length > 0) {
    io.error("usage: validate-toolchain.mjs (takes no arguments)");
    return 2;
  }

  try {
    assertGeneratorIdentity(root, inspect);
    const before = await deploymentRecordDigest(root);

    executePlan(toolchainValidationSteps({ root }), { run, io });

    if (await deploymentRecordDigest(root) !== before) {
      fail(
        "the deployment installation record changed during toolchain " +
          "validation; the two closures must stay independent",
      );
    }

    io.log("toolchain validation complete");
    return 0;
  } catch (error) {
    io.error(`toolchain validation failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
