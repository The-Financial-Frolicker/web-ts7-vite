/**
 * Generator/product boundary tests.
 *
 * These generate real product trees into temporary destinations and inspect
 * them. They never infer the boundary from the manifest alone: the manifest is
 * the input, the generated tree is the evidence.
 */
import assert from "./lib/assert.mjs";
import { run } from "./lib/command.mjs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";
import { runsInGeneratorCheckout } from "./lib/workflow-context.mjs";

import {
  assertDestinationAvailable,
  generateProduct,
  GenerationError,
  GENERATOR_ONLY_TASKS,
  productTasks,
} from "./generate-product.mjs";
import { PLACEHOLDER } from "./init-project.mjs";
import {
  assertManifestDisjoint,
  GENERATOR_ONLY,
  productPaths,
} from "./product-manifest.mjs";

const generatorRoot = path.resolve(import.meta.dirname, "..");
const bash = "/bin/bash";
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

function generate(name = "s93-product") {
  const destination = path.join(makeTempDir("s93-gen-"), "product");
  generateProduct({ root: generatorRoot, destination, name });
  return destination;
}

/** Every file under `root`, relative and sorted. */
function listFiles(root, prefix = "") {
  const files = [];
  for (const name of readdirSync(path.join(root, prefix)).sort()) {
    const relative = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(path.join(root, relative)).isDirectory()) {
      files.push(...listFiles(root, relative));
    } else {
      files.push(relative);
    }
  }
  return files;
}

function hashFiles(root, files) {
  const encoder = new TextEncoder();
  return files.map((file) =>
    `${file}:${readFileSync(path.join(root, file)).length}:` +
    `${[...encoder.encode(readFileSync(path.join(root, file), "utf8"))].length}`
  ).join("\n");
}

/** Read a JSON file from a tree. */
function readJson(root, relative) {
  return JSON.parse(readFileSync(path.join(root, relative), "utf8"));
}

/**
 * Run one of the product's own tasks.
 *
 * `deno task` resolves the `deno` binary through PATH, so the directory of the
 * running executable is prepended instead of assuming the caller's PATH.
 */
function runProductTask(product, task) {
  const denoDirectory = path.dirname(Deno.execPath());
  const result = run(Deno.execPath(), {
    args: ["task", task],
    cwd: product,
    env: {
      ...Deno.env.toObject(),
      PATH: `${denoDirectory}:${Deno.env.get("PATH") ?? ""}`,
    },
  });

  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

/**
 * A product has no dependency tree of its own. Sharing the generator's
 * installed one is exactly what `deno install --frozen` would produce, and it
 * lets contract verification read the same package manifests.
 */
function shareDependencies(product) {
  symlinkSync(
    path.join(generatorRoot, "node_modules"),
    path.join(product, "node_modules"),
  );
}

const hasDependencies = existsSync(path.join(generatorRoot, "node_modules"));
/**
 * A stand-in `deno` that records every task it is asked to run.
 *
 * `scripts/ci.sh` orchestrates tasks; recording them exercises its control flow
 * without building anything. The stub answers success so the stage runs to the
 * end and the whole task sequence can be asserted.
 */
function makeFakeDeno(directory) {
  const log = path.join(directory, "deno-calls.log");
  const file = path.join(directory, "deno");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${log}"`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return log;
}

/** Run one `scripts/ci.sh` stage for a tree with `deno` replaced by the stub. */
function runCiStage(root, stubDirectory, stage) {
  const result = run(bash, {
    args: ["scripts/ci.sh", stage],
    cwd: root,
    env: {
      ...Deno.env.toObject(),
      PATH: `${stubDirectory}:${Deno.env.get("PATH") ?? ""}`,
    },
  });

  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

/** The `deno` invocations the stub recorded, in order. */
function recordedCalls(log) {
  return readFileSync(log, "utf8").split("\n").filter((line) => line !== "");
}

describe("product generation", () => {
  it("generates a product with substituted identity", () => {
    const product = generate("s93-identity");
    const pkg = JSON.parse(
      readFileSync(path.join(product, "package.json"), "utf8"),
    );
    const worker = readFileSync(path.join(product, "worker/index.ts"), "utf8");
    const wrangler = readFileSync(path.join(product, "wrangler.jsonc"), "utf8");

    assert.equal(pkg.name, "s93-identity");
    assert.equal(worker.includes(PLACEHOLDER), false);
    assert.equal(worker.includes("s93-identity-worker"), true);
    assert.equal(wrangler.includes('"name": "s93-identity"'), true);

    for (const file of ["index.html", "README.md"]) {
      assert.equal(
        readFileSync(path.join(product, file), "utf8").includes(
          PLACEHOLDER,
        ),
        false,
        `${file} still contains the placeholder`,
      );
    }
  });

  it("includes the product allowlist and excludes generator machinery", () => {
    const product = generate("s93-boundary");

    for (const relative of productPaths()) {
      assert.equal(
        existsSync(path.join(product, relative)),
        true,
        `missing product artefact ${relative}`,
      );
    }

    for (const relative of GENERATOR_ONLY) {
      assert.equal(
        existsSync(path.join(product, relative)),
        false,
        `generator-only artefact leaked: ${relative}`,
      );
    }

    for (
      const relative of [".contracts", "node_modules", "dist", "build-wasm"]
    ) {
      assert.equal(existsSync(path.join(product, relative)), false, relative);
    }
  });

  it("copies nothing outside the manifest", () => {
    const product = generate("s93-unexpected");
    const allowedTopLevel = new Set(
      productPaths().map((entry) => entry.split("/")[0]),
    );

    for (const name of readdirSync(product)) {
      assert.equal(
        allowedTopLevel.has(name),
        true,
        `unexpected top-level entry in the product: ${name}`,
      );
    }
  });

  it("leaves the generator tree unchanged", () => {
    const watched = [
      "package.json",
      "deno.json",
      "wrangler.jsonc",
      "worker/index.ts",
      "toolchain-contracts.json",
    ];
    const before = hashFiles(generatorRoot, watched);

    generate("s93-generator-intact");

    assert.equal(hashFiles(generatorRoot, watched), before);
  });

  it("is deterministic across two generations", () => {
    const first = generate("s93-deterministic");
    const second = generate("s93-deterministic");
    const files = listFiles(first);

    assert.deepEqual(listFiles(second), files);
    assert.equal(hashFiles(second, files), hashFiles(first, files));
  });

  it("refuses a non-empty destination", () => {
    const destination = makeTempDir("s93-occupied-");
    writeFileSync(path.join(destination, "existing.txt"), "keep me");

    assert.throws(
      () => assertDestinationAvailable(destination),
      GenerationError,
    );
    assert.equal(
      readFileSync(path.join(destination, "existing.txt"), "utf8"),
      "keep me",
    );
  });
});

describe("product task manifest", () => {
  it("removes generator-only tasks and repoints product tests", () => {
    const tasks = productTasks({
      "check:contracts": "check",
      "contract:refresh": "refresh",
      "test:toolchain": "toolchain",
      "test:toolchain-config": "toolchain config",
      "toolchain:prepare": "prepare",
      "test:generator": "generator",
      "init:project": "init",
      "test:contracts": "generator suite",
      validate: "old chain",
    });

    assert.equal("contract:refresh" in tasks, false);
    assert.equal("contract:discover" in tasks, false);
    assert.equal("contract:approve" in tasks, false);
    assert.equal("test:toolchain" in tasks, false);
    assert.equal("test:toolchain-config" in tasks, false);
    assert.equal("toolchain:prepare" in tasks, false);
    assert.equal("toolchain:check" in tasks, false, "the alias must not exist");
    assert.equal("test:generator" in tasks, false);
    assert.equal("init:project" in tasks, false);
    assert.equal(tasks["check:contracts"], "check");
    assert.match(tasks["test:contracts"], /contracts\.verify\.test\.mjs/);
    assert.match(tasks.validate, /deno task check:contracts/);
    assert.doesNotMatch(
      tasks.validate,
      /contract:refresh|contract:discover|contract:approve/,
    );
  });
});
describe("generator-only toolchain boundary", () => {
  /** Tasks that exist only where the toolchain is actually managed. */
  const toolchainTasks = [
    "toolchain:prepare",
    "test:toolchain-config",
  ];

  /** Implementation and test files that back those tasks. */
  const toolchainFiles = [
    "toolchain.toml",
    "scripts/toolchain-prepare.mjs",
    "scripts/toolchain-config.test.mjs",
    "scripts/lib/toolchain/versions.mjs",
    "scripts/lib/toolchain/resolve.mjs",
  ];

  it("keeps toolchain management in the generator", () => {
    const deno = readJson(generatorRoot, "deno.json");

    for (const name of toolchainTasks) {
      assert.equal(name in deno.tasks, true, `generator lost ${name}`);
    }
    for (const relative of toolchainFiles) {
      assert.equal(
        existsSync(path.join(generatorRoot, relative)),
        true,
        `generator lost ${relative}`,
      );
      assert.equal(
        GENERATOR_ONLY.includes(relative),
        true,
        `${relative} must be declared generator-only`,
      );
    }
  });

  it("removes them from the product, its tasks and its files", () => {
    const product = generate("s95-toolchain");
    const deno = readJson(product, "deno.json");
    const pkg = readJson(product, "package.json");

    for (const name of toolchainTasks) {
      assert.equal(
        name in deno.tasks,
        false,
        `${name} leaked into the product`,
      );
      assert.equal(
        name in pkg.scripts,
        false,
        `${name} leaked into npm scripts`,
      );
    }

    for (const relative of toolchainFiles) {
      assert.equal(
        existsSync(path.join(product, relative)),
        false,
        `generator-only toolchain file shipped: ${relative}`,
      );
    }

    // The product inherits its pins as the `.mise.toml` projection it was
    // generated with; it never re-resolves or re-pins them.
    assert.equal(existsSync(path.join(product, ".mise.toml")), true);
  });
});

describe("generator regression suite boundary", () => {
  it("is a generator task that the product never inherits", () => {
    const generatorDeno = readJson(generatorRoot, "deno.json");
    const product = generate("s95-suite");
    const productDeno = readJson(product, "deno.json");
    const productPkg = readJson(product, "package.json");

    assert.equal("test:generator" in generatorDeno.tasks, true);
    assert.match(generatorDeno.tasks.validate, /deno task test:generator/);

    assert.equal("test:generator" in productDeno.tasks, false);
    assert.equal("test:generator" in productPkg.scripts, false);
    assert.doesNotMatch(productDeno.tasks.validate, /test:generator/);
    assert.equal(
      existsSync(path.join(product, "scripts/generate-product.test.mjs")),
      false,
    );
  });
});

describe("product validation and contract verification", () => {
  it("validates with tasks the product actually defines", () => {
    const product = generate("s95-validate");
    const deno = readJson(product, "deno.json");

    const chained = [
      ...deno.tasks.validate.matchAll(/deno task ([a-z0-9:_-]+)/g),
    ].map((match) => match[1]);

    assert.equal(
      chained.length > 0,
      true,
      "the product validate chain is empty",
    );
    for (const name of chained) {
      assert.equal(
        name in deno.tasks,
        true,
        `validate calls missing task ${name}`,
      );
      assert.equal(
        GENERATOR_ONLY_TASKS.includes(name),
        false,
        `validate calls generator-only task ${name}`,
      );
    }

    // No product task may point at a generator-only file: a product can run its
    // own validation only if every path it references was copied. The npm
    // mirrors are rewritten from the same list, so they are held to it too.
    const pkg = readJson(product, "package.json");
    for (const [name, command] of Object.entries(deno.tasks)) {
      for (const relative of GENERATOR_ONLY) {
        assert.equal(
          command.includes(relative),
          false,
          `task ${name} references generator-only ${relative}`,
        );
      }
    }
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      for (const relative of GENERATOR_ONLY) {
        assert.equal(
          command.includes(relative),
          false,
          `npm script ${name} references generator-only ${relative}`,
        );
      }
    }

    // The contract-verification tasks and their implementation are present.
    for (
      const relative of [
        "scripts/check-contracts.sh",
        "scripts/contracts/cli.mjs",
        "scripts/contracts/verify.mjs",
        "scripts/contracts/identity.mjs",
        "scripts/contracts.verify.test.mjs",
        "scripts/edge-verify.mjs",
      ]
    ) {
      assert.equal(
        existsSync(path.join(product, relative)),
        true,
        `product cannot verify contracts without ${relative}`,
      );
    }
    assert.equal("check:contracts" in deno.tasks, true);
    assert.equal("test:contracts" in deno.tasks, true);

    // The gate must be the last step: an unapproved contract cannot hide the
    // product's own suites (mirrors the generator's validate chain).
    assert.equal(
      chained.at(-1),
      "check:contracts",
      `the contract gate must be last: ${chained.join(", ")}`,
    );
    assert.equal(
      chained.filter((name) => name === "check:contracts").length,
      1,
      `the gate must run once: ${chained.join(", ")}`,
    );
  });

  it("runs the product's contract-verification test suite", () => {
    const product = generate("s95-product-tests");
    const result = runProductTask(product, "test:contracts");

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /passed/);
  });

  it("verifies the product's contract artefact", {
    skip: !hasDependencies,
  }, () => {
    const product = generate("s95-product-verify");
    shareDependencies(product);

    const result = runProductTask(product, "check:contracts");

    // The task must reach the verifier, not fail on a missing file or task.
    assert.doesNotMatch(result.output, /Task not found|Module not found/);
    assert.match(result.output, /\[verify\]/);

    // Verification either confirms conformance or reports drift. The outcome
    // itself is asserted by the contract suites; here the requirement is that a
    // product can execute the task and produce a machine-readable report.
    if (result.code === 0) {
      assert.match(result.output, /Conformance OK/);
    } else {
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /Contract conformance failed/);
    }
  });
});

describe("explicit generator-only declarations", () => {
  /** The two artefacts previously excluded only by the positive allowlist. */
  const newlyDeclared = [
    "scripts/generate-product.mjs",
    "scripts/emscripten-provenance.test.mjs",
  ];

  it("keeps the allowlist and the declarations disjoint", () => {
    // Throws on overlap: an artefact cannot be both shipped and generator-only.
    assertManifestDisjoint();
  });

  it("declares only artefacts that exist in the generator", () => {
    for (const relative of GENERATOR_ONLY) {
      // `.contracts` is gitignored local state and legitimately absent.
      if (relative === ".contracts") continue;

      assert.equal(
        existsSync(path.join(generatorRoot, relative)),
        true,
        `${relative} is declared generator-only but does not exist`,
      );
      assert.equal(
        productPaths().includes(relative),
        false,
        `${relative} is declared both a product artefact and generator-only`,
      );
    }
  });

  it("classifies the generator machinery and its provenance suite", () => {
    const product = generate("s95-declared");

    for (const relative of newlyDeclared) {
      assert.equal(
        GENERATOR_ONLY.includes(relative),
        true,
        `${relative} must be declared generator-only`,
      );
      assert.equal(
        existsSync(path.join(generatorRoot, relative)),
        true,
        `generator lost ${relative}`,
      );
      assert.equal(
        existsSync(path.join(product, relative)),
        false,
        `generator-only artefact shipped: ${relative}`,
      );
    }
  });
});

describe("CI lifecycle: project initialisation", () => {
  /** Build stages that must run in both trees, whatever the initialiser does. */
  const requiredStages = [
    "task check:worker-types",
    "task build",
    "task check:deploy",
    "task check:contracts",
    "task test:wasm",
    "task test:wasm:published",
    "task deploy:dry-run",
  ];

  it("initialises the throwaway copy in the generator build stage", () => {
    const stub = makeTempDir("s95-ci-generator-");
    const log = makeFakeDeno(stub);

    const result = runCiStage(generatorRoot, stub, "build");
    const calls = recordedCalls(log);

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /CI-equivalent validation complete/);
    assert.equal(
      calls.includes("task init:project ci-smoke"),
      true,
      `the generator must initialise its throwaway copy: ${calls.join(", ")}`,
    );
    for (const stage of requiredStages) {
      assert.equal(calls.includes(stage), true, `missing stage ${stage}`);
    }
    // The strict gate is the final step, so every build check above runs first.
    assert.equal(
      calls.at(-1),
      "task check:contracts",
      `the contract gate must be last: ${calls.join(", ")}`,
    );
  });

  it("never invokes the generator-only initialiser in a product", () => {
    const product = generate("s95-ci-product");
    // The build stage shares dependencies rather than installing them.
    mkdirSync(path.join(product, "node_modules"));
    const stub = makeTempDir("s95-ci-product-");
    const log = makeFakeDeno(stub);

    const result = runCiStage(product, stub, "build");
    const calls = recordedCalls(log);

    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /CI-equivalent validation complete/);
    assert.equal(
      existsSync(path.join(product, "scripts/init-project.mjs")),
      false,
      "the product must not ship the generator initialiser",
    );
    assert.equal(
      "init:project" in readJson(product, "deno.json").tasks,
      false,
      "the product must not define the initialiser task",
    );
    assert.equal(
      calls.some((call) => call.startsWith("task init:project")),
      false,
      `a product must not initialise itself: ${calls.join(", ")}`,
    );
    // Skipping initialisation must not skip the rest of the stage.
    for (const stage of requiredStages) {
      assert.equal(calls.includes(stage), true, `missing stage ${stage}`);
    }
  });

  /** Static suites a generator tree must run before the contract gate. */
  const generatorStaticSuites = [
    "fmt:check",
    "lint",
    "check:client",
    "check:worker",
    "check:node-boundary",
    "test:init",
    "test:worker",
    "test:boundary",
    "test:toolchain",
    "test:contracts",
    "test:toolchain-config",
    "test:generator",
    "test:vite",
    "test:wrangler-types",
    "test:wrangler-dry-run",
    "test:no-node",
  ];

  it("runs every generator static suite before the contract gate", () => {
    const stub = makeTempDir("s95-ci-static-");
    const log = makeFakeDeno(stub);

    const result = runCiStage(generatorRoot, stub, "static");
    const calls = recordedCalls(log);

    assert.equal(result.code, 0, result.output);
    for (const task of generatorStaticSuites) {
      assert.equal(
        calls.includes(`task ${task}`),
        true,
        `static suite ${task} did not run: ${calls.join(", ")}`,
      );
    }
    // Exactly one gate, and it is last: a failing bootstrap verdict can no
    // longer hide any of the suites above.
    assert.equal(
      calls.filter((call) => call === "task check:contracts").length,
      1,
      `the gate must run once: ${calls.join(", ")}`,
    );
    assert.equal(
      calls.at(-1),
      "task check:contracts",
      `the contract gate must be last: ${calls.join(", ")}`,
    );
  });

  it("runs a product's static suites without generator-only ones", () => {
    const product = generate("s95-ci-static-product");
    const stub = makeTempDir("s95-ci-static-product-bin-");
    const log = makeFakeDeno(stub);

    const result = runCiStage(product, stub, "static");
    const calls = recordedCalls(log);

    assert.equal(result.code, 0, result.output);
    for (
      const task of [
        "fmt:check",
        "lint",
        "check:client",
        "check:worker",
        "check:node-boundary",
        "test:worker",
        "test:boundary",
        "test:contracts",
        "test:vite",
        "test:wrangler-types",
        "test:wrangler-dry-run",
        "test:no-node",
      ]
    ) {
      assert.equal(
        calls.includes(`task ${task}`),
        true,
        `product static suite ${task} did not run: ${calls.join(", ")}`,
      );
    }
    for (
      const generatorOnly of [
        "test:init",
        "test:toolchain",
        "test:toolchain-config",
        "test:generator",
      ]
    ) {
      assert.equal(
        calls.some((call) => call === `task ${generatorOnly}`),
        false,
        `a product must not invoke ${generatorOnly}: ${calls.join(", ")}`,
      );
    }
    assert.equal(
      calls.at(-1),
      "task check:contracts",
      `the contract gate must be last: ${calls.join(", ")}`,
    );
  });
});

describe("shipped workflow coverage", () => {
  /** Split a workflow into steps, keeping each step's body lines. */
  function workflowSteps(text) {
    const steps = [];
    let current = null;

    for (const line of text.split("\n")) {
      const name = /^\s*- name:\s*(.*)$/.exec(line);
      if (name !== null) {
        if (current !== null) steps.push(current);
        current = { name: name[1].trim(), body: [] };
        continue;
      }
      if (current !== null) current.body.push(line);
    }

    if (current !== null) steps.push(current);
    return steps;
  }

  /** `hashFiles('path')` arguments in a step's condition, if any. */
  function guardFiles(step) {
    const condition = step.body
      .map((line) => /^\s*if:\s*(.*)$/.exec(line))
      .find((match) => match !== null);
    if (condition === undefined) return [];

    return [...condition[1].matchAll(/hashFiles\('([^']+)'\)/g)]
      .map((match) => match[1]);
  }

  it("never runs a task the product lacks without a generator-only guard", () => {
    // The workflow ships inside the product, so this validates the artefact a
    // product actually receives — not a hand-maintained expectation list.
    const product = generate("s95-workflow");
    const workflow = readFileSync(
      path.join(product, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const productTasks = new Set(
      Object.keys(readJson(product, "deno.json").tasks),
    );

    const steps = workflowSteps(workflow);
    assert.equal(steps.length > 0, true, "no workflow steps were parsed");

    let references = 0;
    let guardedSkips = 0;
    const unguarded = [];

    for (const step of steps) {
      const body = step.body.join("\n");
      const tasks = [...body.matchAll(/deno task ([a-z0-9:_-]+)/g)]
        .map((match) => match[1]);

      for (const task of tasks) {
        references += 1;
        if (productTasks.has(task)) continue;

        // A generator-only task is authorised only by a declared execution
        // context: the step must run *in* the generator checkout
        // (`working-directory`), never because a `run:` block mentioned it.
        if (runsInGeneratorCheckout(step.body)) continue;
        // A task the product does not define must be skipped by a guard on a
        // file the product genuinely does not receive.
        const guarded = guardFiles(step).some((guard) =>
          existsSync(path.join(generatorRoot, guard)) &&
          !existsSync(path.join(product, guard))
        );

        if (guarded) guardedSkips += 1;
        else unguarded.push(`${step.name}: ${task}`);
      }
    }

    assert.equal(references > 0, true, "no deno task references were found");
    assert.deepEqual(
      unguarded,
      [],
      `unguarded workflow tasks missing from the product: ${
        unguarded.join("; ")
      }`,
    );
    // The guard mechanism itself must be exercised, not merely available.
    assert.equal(
      guardedSkips > 0,
      true,
      "no guarded generator-only step was found in the shipped workflow",
    );
  });
});
