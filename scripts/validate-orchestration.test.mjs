/**
 * Validation orchestration tests.
 *
 * The two entry points are thin: they run the operations the repository already
 * provides, in a fixed order, and remove what they created. These tests replace
 * the process runner, so they assert the orchestration itself — ordering,
 * required installation calls, workspace and tree ownership, isolation, failure
 * propagation, cleanup and repeatability — without installing, building or
 * deploying anything.
 */

import assert from "./lib/assert.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";
import {
  buildHandoffStep,
  createWorkspace,
  deploymentInstallStep,
  deploymentQualifyStep,
  main as deploymentMain,
  removeWorkspace,
  WORKSPACE_PREFIX,
} from "./validate-deployment.mjs";
import {
  assertGeneratorIdentity,
  deploymentRecordDigest,
  main as toolchainMain,
  toolchainValidationSteps,
} from "./validate-toolchain.mjs";

const temporary = [];
function makeDir(prefix = "validation-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporary) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A checkout-shaped root holding only what the orchestrators read. */
function generatorRoot() {
  const root = makeDir("generator-");
  mkdirSync(path.join(root, "generator", "deployment"), { recursive: true });
  writeFileSync(
    path.join(root, "generator", "deployment", "deployment.json"),
    '{"role":"deployment"}\n',
  );
  return root;
}

const TEMPLATE = Object.freeze({
  state: "template",
  // Only the state is consulted; the identity is opaque to the orchestrators.
  identity: { packageName: "<template-identity>" },
});

function inspectTemplate() {
  return TEMPLATE;
}

/** Record every step and answer with the configured exit codes. */
function recorder(responses = []) {
  const calls = [];
  const run = (step) => {
    calls.push({
      command: step.command,
      args: [...(step.args ?? [])],
      cwd: step.cwd,
      env: { ...(step.env ?? {}) },
    });
    const response = responses.find((candidate) => candidate.matches(step));
    return { code: response?.code ?? 0, stdout: response?.stdout ?? "" };
  };
  return { run, calls };
}

/** `deno task <name>` as the orchestrators spell it. */
const isTask = (name) => (step) =>
  (step.args ?? []).join(" ") === `task ${name}`;

function capture() {
  const lines = [];
  return {
    io: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    lines,
  };
}

describe("toolchain validation orchestration", () => {
  it("refuses a checkout whose template identity has been replaced", () => {
    assert.throws(
      () => assertGeneratorIdentity("/work", () => ({ state: "initialised" })),
      /is not a generator template \(state: initialised\)/,
    );
    assert.equal(
      assertGeneratorIdentity("/work", inspectTemplate).state,
      "template",
    );
  });

  it("names the operations qualification needs, in order", () => {
    const root = generatorRoot();

    const steps = toolchainValidationSteps({ root, runtime: "deno" });
    assert.deepEqual(
      steps.map((step) => step.args.join(" ")),
      [
        "task toolchain:install",
        "task check:contracts",
        "task toolchain:qualify",
      ],
    );
    for (const step of steps) assert.equal(step.cwd, root);
  });

  it("installs, verifies conformance, then qualifies — nothing else", async () => {
    const root = generatorRoot();
    const { run, calls } = recorder();
    const { io } = capture();

    const code = await toolchainMain([], {
      root,
      run,
      io,
      inspect: inspectTemplate,
    });

    assert.equal(code, 0);
    assert.deepEqual(
      calls.map((call) => call.args.join(" ")),
      [
        "task toolchain:install",
        "task check:contracts",
        "task toolchain:qualify",
      ],
    );
    assert.equal(
      calls.some((call) => call.args.join(" ").includes("deployment:install")),
      false,
      "toolchain validation must not install the deployment closure",
    );
  });

  it("stops at the first failing step", async () => {
    const root = generatorRoot();
    const { run, calls } = recorder([
      { matches: isTask("check:contracts"), code: 1 },
    ]);
    const { io, lines } = capture();

    const code = await toolchainMain([], {
      root,
      run,
      io,
      inspect: inspectTemplate,
    });

    assert.equal(code, 1);
    assert.match(lines.join("\n"), /verify the installed toolchain/);
    assert.deepEqual(
      calls.map((call) => call.args.join(" ")),
      ["task toolchain:install", "task check:contracts"],
    );
  });

  it("fails when toolchain work changes the deployment installation", async () => {
    const root = generatorRoot();
    const record = path.join(
      root,
      "generator",
      "deployment",
      "deployment.json",
    );
    const { run } = recorder();
    const { io, lines } = capture();

    // Simulate a toolchain step that wrote into the deployment tree.
    const tamperingRun = (step) => {
      writeFileSync(record, '{"role":"deployment","touched":true}\n');
      return run(step);
    };

    const code = await toolchainMain([], {
      root,
      run: tamperingRun,
      io,
      inspect: inspectTemplate,
    });

    assert.equal(code, 1);
    assert.match(lines.join("\n"), /must stay independent/);
  });

  it("reads the deployment record without requiring one", async () => {
    assert.equal(
      typeof await deploymentRecordDigest(generatorRoot()),
      "string",
    );
    assert.equal(
      await deploymentRecordDigest(makeDir("no-record-")),
      undefined,
    );
  });
});

describe("deployment validation orchestration", () => {
  it("declares a workspace inside the caller's temporary root", () => {
    const parent = makeDir("parent-");
    const workspace = createWorkspace({ TMPDIR: parent });

    assert.ok(
      workspace.startsWith(path.join(parent, WORKSPACE_PREFIX)),
      `${workspace} must live under ${parent}`,
    );
    assert.equal(existsSync(workspace), true);
  });

  it("builds into the workspace it owns and qualifies there", () => {
    const root = generatorRoot();
    const workspace = makeDir(WORKSPACE_PREFIX);
    const { run, calls } = recorder();
    const { io } = capture();

    const code = deploymentMain([], {
      root,
      run,
      io,
      env: { PATH: "/usr/bin" },
      inspect: inspectTemplate,
      create: () => workspace,
      remove: () => true,
    });

    assert.equal(code, 0);
    assert.deepEqual(
      calls.map((call) => `${call.cwd} :: ${call.args.join(" ")}`),
      [
        `${root} :: task toolchain:install`,
        `${root} :: scripts/ci.sh build`,
        `${workspace} :: task deployment:install -- --allow-download`,
        `${workspace} :: task deployment:qualify`,
      ],
    );

    const build = calls[1];
    assert.equal(build.env.CI_WORK_DIR, workspace);
    assert.equal(build.env.CI_PACK_HANDOFF, "1");
    assert.equal(
      build.env.GENERATOR_PROJECT_ROOT,
      undefined,
      "the copy routine names its own checkout",
    );

    // The deployment closure belongs to the copy: nothing is installed into the
    // generator checkout, and qualification runs with no root override in play.
    for (const call of calls) {
      if (call.cwd !== root) continue;
      assert.equal(
        call.args.includes("deployment:install"),
        false,
        `the deployment closure must not be installed in the checkout: ${call.args}`,
      );
    }
    const qualify = calls[3];
    assert.equal(qualify.env.GENERATOR_PROJECT_ROOT, undefined);
    assert.equal(qualify.env.GENERATOR_ROOT, undefined);
  });

  it("never builds or installs into the generator checkout itself", () => {
    const root = generatorRoot();
    const workspace = makeDir(WORKSPACE_PREFIX);

    const build = buildHandoffStep({ root, workspace, env: {} });
    assert.equal(build.cwd, root, "the copy routine runs from the checkout");
    assert.equal(build.args.join(" "), "scripts/ci.sh build");
    assert.equal(build.env.CI_WORK_DIR, workspace);

    const install = deploymentInstallStep({ workspace, env: {} });
    assert.equal(install.cwd, workspace);
    assert.ok(
      install.args.join(" ").includes("deployment:install"),
      install.args.join(" "),
    );

    const qualify = deploymentQualifyStep({ workspace, env: {} });
    assert.equal(qualify.cwd, workspace);
    assert.ok(
      qualify.cwd !== root,
      "qualification must not run in the generator checkout",
    );
  });

  it("removes the workspace when the build fails", () => {
    const root = generatorRoot();
    const workspace = makeDir(WORKSPACE_PREFIX);
    const removed = [];
    const { run } = recorder([
      { matches: (step) => step.args.includes("build"), code: 1 },
    ]);
    const { io, lines } = capture();

    const code = deploymentMain([], {
      root,
      run,
      io,
      env: {},
      inspect: inspectTemplate,
      create: () => workspace,
      remove: (value) => removed.push(value),
    });

    assert.equal(code, 1);
    assert.match(lines.join("\n"), /isolated workspace failed/);
    assert.deepEqual(removed, [workspace]);
  });

  it("removes the workspace when qualification fails", () => {
    const root = generatorRoot();
    const workspace = makeDir(WORKSPACE_PREFIX);
    const removed = [];
    const { run, calls } = recorder([
      { matches: isTask("deployment:qualify"), code: 1 },
    ]);
    const { io } = capture();

    const code = deploymentMain([], {
      root,
      run,
      io,
      env: {},
      inspect: inspectTemplate,
      create: () => workspace,
      remove: (value) => removed.push(value),
    });

    assert.equal(code, 1);
    assert.equal(calls.length, 4);
    assert.deepEqual(removed, [workspace]);
  });

  it("never converts the generator checkout's identity", () => {
    const root = generatorRoot();
    const workspace = makeDir(WORKSPACE_PREFIX);
    const { run } = recorder();
    const { io, lines } = capture();

    const code = deploymentMain([], {
      root,
      run,
      io,
      env: {},
      inspect: () => ({ state: "initialised" }),
      create: () => workspace,
      remove: () => true,
    });

    assert.equal(code, 1);
    assert.match(lines.join("\n"), /is not a generator template/);
  });

  it("is repeatable: the same operations run twice with the same shape", () => {
    const root = generatorRoot();
    const first = recorder();
    const second = recorder();

    for (const instance of [first, second]) {
      const { io } = capture();
      const code = deploymentMain([], {
        root,
        run: instance.run,
        io,
        env: {},
        inspect: inspectTemplate,
        create: () => makeDir(WORKSPACE_PREFIX),
        remove: (value) => rmSync(value, { recursive: true, force: true }),
      });
      assert.equal(code, 0);
    }

    assert.deepEqual(
      first.calls.map((call) => call.args.join(" ")),
      second.calls.map((call) => call.args.join(" ")),
    );
  });
});

describe("workspace removal", () => {
  it("removes one of its own workspaces", () => {
    const workspace = makeDir(WORKSPACE_PREFIX);
    const { io } = capture();

    assert.equal(removeWorkspace(workspace, io), true);
    assert.equal(existsSync(workspace), false);
  });

  it("refuses anything that is not one of its workspaces", () => {
    const directory = makeDir("keep-me-");
    const { io, lines } = capture();

    assert.equal(removeWorkspace(directory, io), false);
    assert.equal(existsSync(directory), true);
    assert.match(lines.join("\n"), /refusing to remove/);
  });

  it("treats an already removed workspace as clean-up complete", () => {
    const workspace = makeDir(WORKSPACE_PREFIX);
    rmSync(workspace, { recursive: true, force: true });
    const { io } = capture();

    assert.equal(removeWorkspace(workspace, io), false);
  });
});
