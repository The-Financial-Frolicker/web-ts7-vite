/**
 * CI workflow contract tests (S7-D).
 *
 * Structural by design: the workflow is the ownership boundary, so these
 * assertions read the shipped file. They can prove that the two repository roles
 * are mutually exclusive, that the product path gates every task behind
 * provenance verification, and that no generator-only task leaks into it.
 */

import assert from "./lib/assert.mjs";
import { existsSync, readdirSync, readFileSync } from "./lib/fs.mjs";
import path from "./lib/path.mjs";
import { describe, it } from "./lib/test.mjs";

const workflow = readFileSync(
  path.join(Deno.cwd(), ".github", "workflows", "ci.yml"),
  "utf8",
);

// The role discriminator is a classifier step output. The marker file is still
// the source of truth, but it is tested in a shell step: GitHub rejects
// `hashFiles()` inside a job-level `if:`, so the decision cannot live there.
const ROLE = "needs.classify.outputs.generator";
const MARKER_FILE = "toolchain/deno.lock";

/**
 * Reject duplicate mapping keys in block-style YAML.
 *
 * GitHub refuses a workflow that repeats a key in the same mapping — the G2 push
 * failed with zero jobs because one step carried two `run:` keys — but permissive
 * parsers silently keep the last one. This checker walks the block structure
 * (indentation scopes, sequence items, block scalars) rather than matching text,
 * so a key is only ever compared with keys belonging to the same mapping.
 *
 * Returns `null` when the document is unambiguous, or
 * `{ key, line, firstLine, label }` for the first duplicate found.
 */
export function findDuplicateMappingKey(source, label = "workflow") {
  const lines = source.split("\n");
  const frames = [];

  const top = () => (frames.length === 0 ? null : frames[frames.length - 1]);

  const isBlockScalar = (value) => value !== "" && "|>".includes(value[0]);

  const keyOf = (text) => {
    const colon = text.indexOf(":");
    if (colon <= 0) return null;
    const key = text.slice(0, colon);
    // A block-mapping key never contains whitespace; a bare scalar might.
    if (key.trim() !== key || /\s/.test(key)) return null;
    return { key, value: text.slice(colon + 1).trim() };
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = raw.length - raw.trimStart().length;
    let text = trimmed;
    let keyIndent = indent;

    // A sequence entry opens a fresh mapping scope for the keys that follow.
    if (text === "-" || text.startsWith("- ")) {
      while (top() !== null && top().indent > indent) frames.pop();
      text = text.slice(1).trimStart();
      keyIndent = indent + 2;
      frames.push({ indent: keyIndent, keys: new Map() });
      if (text === "") continue;
    }

    const entry = keyOf(text);
    if (entry === null) continue;

    while (top() !== null && top().indent > keyIndent) frames.pop();
    if (top() === null || top().indent < keyIndent) {
      frames.push({ indent: keyIndent, keys: new Map() });
    }

    const frame = top();
    if (frame.keys.has(entry.key)) {
      return {
        key: entry.key,
        line: index + 1,
        firstLine: frame.keys.get(entry.key),
        label,
      };
    }
    frame.keys.set(entry.key, index + 1);

    // Content of a block scalar is data, never keys: skip to the dedent.
    if (isBlockScalar(entry.value)) {
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        const nextTrimmed = next.trim();
        if (
          nextTrimmed !== "" &&
          next.length - next.trimStart().length <= keyIndent
        ) {
          break;
        }
        index += 1;
      }
    }
  }

  return null;
}

function jobCondition(name) {
  const match = new RegExp(`^  ${name}:\\n(?:    .*\\n)*?    if: (.+)$`, "m")
    .exec(workflow);
  assert.ok(match !== null, `job ${name} has no explicit if condition`);
  return match[1].trim();
}

function jobBody(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start !== -1, `job ${name} is missing`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The lines belonging to one job, bounded by the next top-level job key. */
function jobLines(name, source = workflow) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start !== -1, `job ${name} is missing`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[a-z0-9_-]+:$/.test(lines[index])) {
      end = index;
      break;
    }
  }

  return { lines, start, end };
}

/**
 * Declarations made by the job itself (indent 4), never by one of its steps.
 *
 * GitHub checks expression contexts per location: `hashFiles()` is legal in a
 * step `if:` but rejected in a job `if:`, and the `runner` context is legal in a
 * step `env:` but rejected in a job `env:`. Step declarations sit at indent 8 or
 * deeper, so that indentation boundary is what separates the two.
 *
 * Limitation: an indentation reader for the block style this repository uses. It
 * is not a YAML parser and not a general GitHub Actions schema validator.
 */
function jobDeclarations(name, source = workflow) {
  const { lines, start, end } = jobLines(name, source);
  const declarations = [];

  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    const indent = line.length - line.trimStart().length;
    if (indent !== 4) continue;

    const text = line.trim();
    const colon = text.indexOf(":");
    if (colon <= 0) continue;
    const key = text.slice(0, colon);
    if (!/^[a-z0-9_-]+$/.test(key)) continue;

    const block = [];
    for (let next = index + 1; next < end; next += 1) {
      const candidate = lines[next];
      const candidateIndent = candidate.length - candidate.trimStart().length;
      if (candidate.trim() !== "" && candidateIndent <= 4) break;
      block.push(candidate);
    }

    declarations.push({
      key,
      value: text.slice(colon + 1).trim(),
      block,
      line: index + 1,
    });
  }

  return declarations;
}

/** Job names declared under `jobs:`, in file order, for any workflow text. */
export function workflowJobNames(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === "jobs:");
  if (start === -1) return [];

  const names = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== "" && !line.startsWith(" ")) break;

    const match = /^ {2}([a-z0-9_-]+):$/.exec(line);
    if (match !== null) names.push(match[1]);
  }
  return names;
}

/**
 * Contexts GitHub rejects in a job-level declaration, and where each is judged.
 *
 * Only the two locations this repository already relies on are modelled: the
 * point is context availability, not a reimplementation of the Actions schema.
 * `runner` is step-scoped, so a job-level `env` may not reference it; `hashFiles()`
 * needs a checkout context the job-level `if:` is evaluated without.
 */
export const JOB_LEVEL_CONTEXT_RULES = Object.freeze([
  Object.freeze({
    key: "env",
    context: "runner",
    pattern: /\$\{\{[^}]*\brunner\b/,
  }),
  Object.freeze({
    key: "if",
    context: "hashFiles()",
    pattern: /hashFiles\(/,
  }),
]);

/**
 * Every prohibited job-level context reference in one workflow text.
 *
 * Comments are part of the declaration block and may legitimately mention a
 * context, so only an actual `${{ … }}` expression (or the `hashFiles()` call the
 * `if:` rule keys on) counts as a violation.
 */
export function jobLevelContextViolations(source, label = "workflow") {
  const violations = [];

  for (const job of workflowJobNames(source)) {
    for (const entry of jobDeclarations(job, source)) {
      const text = [entry.value, ...entry.block].join("\n");

      for (const rule of JOB_LEVEL_CONTEXT_RULES) {
        if (entry.key !== rule.key) continue;
        if (!rule.pattern.test(text)) continue;
        violations.push({
          label,
          job,
          key: entry.key,
          context: rule.context,
          line: entry.line,
        });
      }
    }
  }

  return violations;
}

/**
 * Workflow files maintained in this checkout.
 *
 * Discovery is directory-based on purpose: the product manifest publishes paths
 * that live under `.github/workflows`, so every file that can be published is
 * discovered here without a second list to keep in step.
 */
export function workflowFiles(root = Deno.cwd()) {
  const directory = path.join(root, ".github", "workflows");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

describe("repository role discrimination", () => {
  it("gates every job on the classifier's role output", () => {
    for (const name of ["validate", "build", "product"]) {
      assert.ok(
        jobCondition(name).includes(ROLE),
        `job ${name} does not discriminate on ${ROLE}`,
      );
    }
  });

  it("makes the generator and product roles mutually exclusive", () => {
    const generator = ["validate", "build"].map(jobCondition);
    const product = jobCondition("product");

    for (const condition of generator) {
      assert.ok(condition.includes("== 'true'"), condition);
      assert.ok(!condition.includes("== 'false'"), condition);
    }
    assert.ok(product.includes("== 'false'"), product);
    assert.ok(!product.includes("== 'true'"), product);
  });

  it("does not use product provenance to distinguish roles", () => {
    for (const name of ["validate", "build", "product"]) {
      assert.ok(
        !jobCondition(name).includes("toolchain-source"),
        `job ${name} relies on product metadata for role discrimination`,
      );
    }
  });
});

describe("product job sequencing", () => {
  const body = jobBody("product");

  it("validates metadata before any generator checkout", () => {
    const read = body.indexOf("read --format=github");
    const checkout = body.indexOf("Check out the recorded generator release");
    assert.ok(read !== -1 && checkout !== -1, "stages A and B must be present");
    assert.ok(read < checkout, "Stage A must precede the generator checkout");
  });

  it("verifies the release identity before provisioning", () => {
    const identity = body.indexOf("Verify the generator release identity");
    const provision = body.indexOf("toolchain:install -- --allow-download");
    assert.ok(
      identity !== -1 && provision !== -1,
      "stages B and C must be present",
    );
    assert.ok(
      identity < provision,
      "the SHA/tag check must precede provisioning",
    );
    assert.ok(
      body.includes("cat-file -t") && body.includes("rev-parse HEAD"),
      "the checkout SHA and annotated-tag checks must both be present",
    );
  });

  it("verifies materialisation before any product task", () => {
    const verify = body.indexOf("--generator");
    const firstTask = body.indexOf("deno task check:client");
    assert.ok(
      verify !== -1 && firstTask !== -1,
      "Stage D and Stage E must be present",
    );
    assert.ok(
      verify < firstTask,
      "no product task may precede the provenance gate",
    );
    assert.ok(
      body.includes("--generator") && body.includes("--generator-root"),
      "the verifier must receive the verified checkout and the installation root",
    );
  });

  it("provisions outside the product checkout, without implicit installation", () => {
    assert.ok(
      body.includes("GENERATOR_PROJECT_ROOT:"),
      "GENERATOR_PROJECT_ROOT must name the verified generator checkout",
    );
    assert.ok(
      body.includes("${{ runner.temp }}/generator"),
      "the installation must live outside the product checkout",
    );
    assert.ok(
      body.includes("GENERATOR_PROJECT_ROOT/generator/dependencies"),
      "the verifier must receive the generator-owned installation root",
    );
    assert.ok(
      !body.includes("deno install"),
      "no implicit dependency installation",
    );
    assert.ok(
      body.includes("persist-credentials: false"),
      "checkouts must not persist credentials",
    );
    // Execution context is declared, not inferred from shell text: the
    // provisioning step must name the verified generator checkout.
    assert.ok(
      body.includes("working-directory: ${{ runner.temp }}/generator"),
      "provisioning must declare the verified generator checkout as its context",
    );
    // Metadata must reach $GITHUB_OUTPUT through the CLI's structured mode, not
    // through a shell translation, and never through eval.
    assert.ok(
      body.includes("read --format=github"),
      "Stage A must use the structured output mode",
    );
    assert.ok(
      !body.includes("sed 's/^TC_"),
      "no shell translation of metadata into GitHub output",
    );
    assert.ok(!body.includes("eval "), "metadata must never reach eval");
  });

  it("never runs a generator-only task", () => {
    for (
      const forbidden of [
        "product:generate",
        "init:project",
        "test:generator",
        "toolchain:specify",
      ]
    ) {
      assert.ok(
        !body.includes(forbidden),
        `the product job must not run generator-only task ${forbidden}`,
      );
    }
  });

  describe("workflow YAML strictness", () => {
    // Role-aware by construction. A generated product ships exactly one
    // workflow, `ci.yml`; the generator additionally ships the two workflows
    // only the generator role can run. A test that demanded all three
    // everywhere would either fail on a correctly generated product or force
    // generator-only files into it, so the classifier's own marker decides
    // which set this checkout owes, and both roles keep full coverage of theirs.
    const workflowsDirectory = path.join(Deno.cwd(), ".github", "workflows");
    const generatorOnlyWorkflows = [
      "authoritative-toolchain.yml",
      "edge-acceptance.yml",
    ];
    const isGenerator = existsSync(path.join(Deno.cwd(), MARKER_FILE));

    it("accepts every shipped workflow with a duplicate-key-rejecting reader", () => {
      const shipped = readdirSync(workflowsDirectory)
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort();

      // `ci.yml` is the one workflow both roles ship, so its absence is a
      // defect in either role rather than a boundary difference.
      assert.ok(shipped.includes("ci.yml"), "ci.yml must be shipped");

      for (const name of shipped) {
        const source = readFileSync(
          path.join(workflowsDirectory, name),
          "utf8",
        );
        assert.equal(
          findDuplicateMappingKey(source, name),
          null,
          `${name} must contain no duplicate mapping keys`,
        );
      }
    });

    it("holds each role to its own workflow set", () => {
      // Symmetric on purpose: the generator must ship both generator-only
      // workflows, and a product must not acquire them merely to satisfy a
      // generator-level test. A product may still add workflows of its own; the
      // strictness test above parses whatever it finds.
      for (const name of generatorOnlyWorkflows) {
        assert.equal(
          existsSync(path.join(workflowsDirectory, name)),
          isGenerator,
          `${name} must ${
            isGenerator ? "" : "not "
          }be present in this repository role`,
        );
      }
    });

    it("rejects a repeated mapping key, exactly as GitHub does", () => {
      // The shape that failed the G2 push: one step carrying two `run:` keys, the
      // second of which a permissive parser silently keeps.
      const broken = [
        "jobs:",
        "  validate:",
        "    steps:",
        "      - name: identity",
        "        run: |",
        "          echo verified",
        "        run: mise exec -- deno task fmt:check",
        "",
      ].join("\n");

      const found = findDuplicateMappingKey(broken, "fixture");
      assert.ok(found !== null, "a repeated key must be rejected");
      assert.equal(found.key, "run", "the diagnostic must name the key");
      assert.equal(
        found.line,
        7,
        "the diagnostic must name the offending line",
      );
      assert.equal(
        found.firstLine,
        5,
        "the diagnostic must name the first use",
      );
      assert.equal(
        found.label,
        "fixture",
        "the diagnostic must name the document",
      );
    });

    it("does not confuse keys belonging to different mappings", () => {
      const fine = [
        "jobs:",
        "  a:",
        "    steps:",
        "      - name: one",
        "        run: echo 1",
        "      - name: two",
        "        run: echo 2",
        "  b:",
        "    steps:",
        "      - name: three",
        "        run: echo 3",
        "",
      ].join("\n");

      assert.equal(
        findDuplicateMappingKey(fine, "fixture"),
        null,
        "repeated keys in sibling mappings are legitimate",
      );
    });
  });

  function jobNeeds(name) {
    const entry = jobDeclarations(name).find((item) => item.key === "needs");
    if (entry === undefined) return [];
    return entry.value.replace(/[[\]]/g, "").split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }

  describe("role classification", () => {
    it("publishes the role from a step output, not a workflow expression", () => {
      const outputs = jobDeclarations("classify").find((item) =>
        item.key === "outputs"
      );
      assert.ok(outputs !== undefined, "the classifier must declare outputs");
      assert.ok(
        outputs.block.join("\n").includes(
          "generator: ${{ steps.marker.outputs.generator }}",
        ),
        outputs.block.join("\n"),
      );

      const body = jobBody("classify");
      assert.ok(body.includes("id: marker"), "the deciding step must be named");
      assert.ok(
        body.includes(`[ -f ${MARKER_FILE} ]`),
        `the classifier must test the marker file ${MARKER_FILE}`,
      );
      assert.ok(
        body.includes("persist-credentials: false"),
        "the classifier checkout must not persist credentials",
      );
    });

    it("makes the generator jobs depend on it and select the generator role", () => {
      for (const name of ["validate", "build"]) {
        assert.ok(
          jobNeeds(name).includes("classify"),
          `job ${name} must declare needs: classify`,
        );
        assert.ok(jobCondition(name).includes(`${ROLE} == 'true'`), name);
      }
    });

    it("makes the product job depend on it and select the product role", () => {
      assert.ok(jobNeeds("product").includes("classify"));
      assert.ok(jobCondition("product").includes(`${ROLE} == 'false'`));
    });

    it("keeps the classifier a discriminator, not an installer or validator", () => {
      const body = jobBody("classify");
      for (const forbidden of ["toolchain:install", "mise exec", "deno task"]) {
        assert.ok(
          !body.includes(forbidden),
          `the classifier must not run ${forbidden}`,
        );
      }
    });
  });

  describe("job-level expression contexts", () => {
    it("never uses hashFiles() in a job-level if", () => {
      const violations = jobLevelContextViolations(workflow, "ci.yml").filter(
        (violation) => violation.key === "if",
      );
      assert.equal(violations.length, 0, JSON.stringify(violations));
    });

    it("never uses the runner context in a job-level env", () => {
      const violations = jobLevelContextViolations(workflow, "ci.yml").filter(
        (violation) => violation.key === "env",
      );
      assert.equal(violations.length, 0, JSON.stringify(violations));
    });

    it("still permits those contexts where GitHub allows them", () => {
      // A step-level `runner` reference is exactly what the product job relies on.
      assert.ok(
        jobBody("product").includes(
          "GENERATOR_PROJECT_ROOT: ${{ runner.temp }}/generator",
        ),
        "product steps must declare the installation path at step level",
      );

      // And the classifier decides with a file test in a shell step.
      const classifier = jobBody("classify");
      assert.ok(classifier.includes(`[ -f ${MARKER_FILE} ]`));
      assert.ok(!classifier.includes("hashFiles("));
    });
  });

  describe("job-level context detection", () => {
    // The same expression is legal one level down: GitHub only rejects it where
    // the context is unavailable. A detector that flagged the step-level uses too
    // would be useless, so this fixture carries both and proves the boundary.
    const mixed = [
      "jobs:",
      "  validate:",
      "    if: hashFiles('toolchain/deno.lock') != ''",
      "    env:",
      "      GENERATOR_PROJECT_ROOT: ${{ runner.temp }}/generator",
      "    steps:",
      "      - name: legitimate step",
      "        if: hashFiles('toolchain/deno.lock') != ''",
      "        env:",
      "          GENERATOR_PROJECT_ROOT: ${{ runner.temp }}/generator",
      "        run: echo ok",
      "  build:",
      "    steps:",
      "      - name: another step",
      "        run: echo ok",
      "",
    ].join("\n");

    it("reads job-level declarations and nothing deeper", () => {
      const declarations = jobDeclarations("validate", mixed);
      assert.equal(
        declarations.filter((item) => item.key === "if").length,
        1,
        "only the job-level if must be collected",
      );
      assert.equal(
        declarations.filter((item) => item.key === "env").length,
        1,
        "only the job-level env must be collected",
      );
      assert.equal(
        declarations.filter((item) => item.key === "steps").length,
        1,
      );
    });

    it("detects hashFiles() and the runner context at job level", () => {
      const declarations = jobDeclarations("validate", mixed);
      const condition = declarations.find((item) => item.key === "if");
      const environment = declarations.find((item) => item.key === "env");

      assert.ok(condition.value.includes("hashFiles("), condition.value);
      assert.ok(
        [environment.value, ...environment.block].join("\n").includes("runner"),
        environment.block.join("\n"),
      );
    });
  });

  describe("generated product acceptance profile", () => {
    const anchor = workflow.indexOf("- name: Generated product independence");
    assert.ok(anchor !== -1, "the product independence step must exist");

    const remainder = workflow.slice(anchor);
    const nextStep = remainder.slice(1).search(/\n {6}- (name|uses):/);
    const step = nextStep === -1 ? remainder : remainder.slice(0, nextStep + 1);

    it("selects the documented CI profile for the whole step", () => {
      assert.ok(
        step.includes("VITE_PERMISSION_PROFILE: ci-runner"),
        "the step must select the ci-runner profile at step level",
      );
    });

    it("covers every product task the step runs", () => {
      for (
        const task of [
          "check:client",
          "check:worker",
          "build",
          "deploy:dry-run",
        ]
      ) {
        assert.ok(
          step.includes(`deno task ${task}`),
          `the step must still run ${task}`,
        );
      }
    });

    it("carries the grant in the profile, never on the command line", () => {
      assert.ok(
        !step.includes("--allow-all"),
        "the ci-runner profile owns the grant; the step must not widen it inline",
      );
    });
  });

  describe("toolchain identity probes and diagnostics", () => {
    const anchor = workflow.indexOf(
      "- name: Record and verify the toolchain identity",
    );
    assert.ok(anchor !== -1, "the identity step must exist");

    const remainder = workflow.slice(anchor);
    const nextStep = remainder.slice(1).search(/\n {6}- (name|uses):/);
    const step = nextStep === -1 ? remainder : remainder.slice(0, nextStep + 1);
    const probes = step.split("\n").filter((line) =>
      /^\s*test -[a-z]/.test(line)
    );

    it("requires the workerd runtime to be executable", () => {
      const workerd = probes.find((line) => line.includes("workerd"));
      assert.ok(workerd !== undefined, "the workerd probe must exist");
      assert.ok(workerd.includes("test -x"), workerd);
    });

    it("requires the rolldown binding to be a readable regular file", () => {
      const binding = probes.filter((line) => line.includes(".node"));
      assert.ok(binding.length > 0, "the rolldown probe must exist");

      const text = binding.join("\n");
      assert.ok(text.includes("test -f"), text);
      assert.ok(text.includes("test -r"), text);
      assert.ok(
        !text.includes("test -x"),
        "a native shared library must not be required to be executable",
      );
    });

    it("reports compact materialisation diagnostics", () => {
      assert.ok(
        step.includes("files=${tree.files}"),
        "the entry counters must be reported",
      );
      assert.ok(
        step.includes("mode-column sha256="),
        "the mode column must be reported",
      );
      assert.ok(
        step.includes("path-column sha256="),
        "the path column must be reported",
      );
      assert.ok(
        step.includes("path-mode-column sha256="),
        "the path-to-mode binding must be reported",
      );
    });
  });
});

describe("workflow context scope (every published workflow)", () => {
  const workflowsDirectory = path.join(Deno.cwd(), ".github", "workflows");
  const files = workflowFiles();

  function sourceOf(name) {
    return readFileSync(path.join(workflowsDirectory, name), "utf8");
  }

  it("discovers every workflow file maintained in this checkout", () => {
    const onDisk = readdirSync(workflowsDirectory)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();

    // Discovery is the directory, so a newly added workflow is covered without
    // anyone remembering to add its name here.
    assert.deepEqual(files, onDisk);
    assert.ok(files.includes("ci.yml"), "ci.yml is shipped in both roles");
  });

  it("covers every workflow file the product manifest publishes", async () => {
    const manifestPath = path.join(
      Deno.cwd(),
      "scripts",
      "product-manifest.mjs",
    );

    if (!existsSync(manifestPath)) {
      // A generated product publishes nothing from its own checkout, so the
      // discovered set is the whole obligation there.
      assert.deepEqual(files, ["ci.yml"]);
      return;
    }

    const manifest = await import(
      new URL("./product-manifest.mjs", import.meta.url).href
    );
    const published = manifest.productPaths()
      .filter((entry) => entry.startsWith(".github/workflows/"))
      .map((entry) => entry.slice(".github/workflows/".length))
      .sort();

    assert.ok(published.length > 0, "the manifest must publish a workflow");
    for (const name of published) {
      assert.ok(
        files.includes(name),
        `${name} is published but was not discovered`,
      );
    }
  });

  it("applies the context-scope rules to every discovered workflow", () => {
    for (const name of files) {
      assert.deepEqual(
        jobLevelContextViolations(sourceOf(name), name),
        [],
        `${name} references a context where GitHub does not provide it`,
      );
    }
  });

  it("permits those contexts at step scope", () => {
    const fixture = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - name: step",
      "        if: hashFiles('toolchain/deno.lock') != ''",
      "        env:",
      "          GENERATOR_PROJECT_ROOT: ${{ runner.temp }}/generator",
      "        run: echo ok",
      "",
    ].join("\n");

    assert.deepEqual(jobLevelContextViolations(fixture, "fixture"), []);
  });

  it("rejects the runner context in a job-level env", () => {
    // The P9 defect, reduced: this is what made the published workflow invalid.
    const fixture = [
      "jobs:",
      "  acceptance:",
      "    env:",
      "      WORK_DIR: ${{ runner.temp }}/acceptance-1-1",
      "    steps:",
      "      - name: step",
      "        run: echo ok",
      "",
    ].join("\n");

    assert.deepEqual(jobLevelContextViolations(fixture, "fixture"), [
      {
        label: "fixture",
        job: "acceptance",
        key: "env",
        context: "runner",
        line: 3,
      },
    ]);
  });

  it("rejects hashFiles() in a job-level if", () => {
    const fixture = [
      "jobs:",
      "  build:",
      "    if: hashFiles('toolchain/deno.lock') != ''",
      "    steps:",
      "      - name: step",
      "        run: echo ok",
      "",
    ].join("\n");

    assert.deepEqual(jobLevelContextViolations(fixture, "fixture"), [
      {
        label: "fixture",
        job: "build",
        key: "if",
        context: "hashFiles()",
        line: 3,
      },
    ]);
  });

  it("does not read a prose mention of a context as an expression", () => {
    const fixture = [
      "jobs:",
      "  build:",
      "    env:",
      "      # The runner's temporary directory is not available here.",
      "      GENERATOR_ROOT: /tmp/toolchain",
      "    steps:",
      "      - name: step",
      "        run: echo ok",
      "",
    ].join("\n");

    assert.deepEqual(jobLevelContextViolations(fixture, "fixture"), []);
  });
});

/**
 * Build/deployment separation.
 *
 * The split is a structural guarantee, so it is asserted structurally: the
 * deployment job must not be able to build, and it must consume the hand-off the
 * build job uploaded. A workflow that quietly re-grew a build step in the
 * deployment job would fail here rather than passing silently.
 *
 * Edge acceptance is generator-only and absent from a generated product, so its
 * assertions are skipped when the file is not shipped.
 */
function bodyOf(source, name) {
  const { lines, start, end } = jobLines(name, source);
  return lines.slice(start + 1, end).join("\n");
}

function deployedWorkflow() {
  const file = path.join(
    Deno.cwd(),
    ".github",
    "workflows",
    "edge-acceptance.yml",
  );
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

const BUILD_COMMANDS = [
  "deno task build",
  "scripts/build.sh",
  "scripts/build-wasm.sh",
  "deno task ci",
  "artefact:pack",
];

describe("build/deployment separation in ci.yml", () => {
  it("has a build job that packages and uploads the hand-off", () => {
    const body = bodyOf(workflow, "handoff");
    assert.ok(body.includes("deno task artefact:pack"), body);
    assert.ok(body.includes("uses: actions/upload-artifact"), body);
    assert.ok(
      body.includes("include-hidden-files: true"),
      "the hand-off upload must keep hidden payload files",
    );
    assert.ok(
      !body.includes("CLOUDFLARE"),
      "the build job needs no credentials",
    );
  });

  it("has a deployment job that consumes the uploaded hand-off", () => {
    const body = bodyOf(workflow, "deployment");
    assert.ok(body.includes("uses: actions/download-artifact"), body);
    assert.ok(body.includes("deno task artefact:verify"), body);
    assert.ok(body.includes("deno task deploy:artefact:dry-run"), body);
  });

  it("makes the deployment job depend on the build job", () => {
    const { lines, start, end } = jobLines("deployment");
    const needs = lines.slice(start + 1, end).find((line) =>
      line.trimStart().startsWith("needs:")
    );
    assert.ok(needs !== undefined && needs.includes("handoff"), String(needs));
  });

  it("cannot build in the deployment job", () => {
    const body = bodyOf(workflow, "deployment");
    for (const command of BUILD_COMMANDS) {
      assert.ok(
        !body.includes(command),
        `the deployment job must not run ${command}`,
      );
    }
  });

  it("installs no build toolchain in the deployment job", () => {
    const body = bodyOf(workflow, "deployment");
    assert.ok(body.includes("mise install deno"), body);
    assert.ok(
      !/mise exec -- (emcc|cmake|ninja|tsc)/.test(body),
      "the deployment job must not invoke a build tool",
    );
  });
});

describe("build/deployment separation in edge acceptance", () => {
  const source = deployedWorkflow();

  it("splits the build from the deployment", () => {
    if (source === null) return;
    const build = bodyOf(source, "edge-build");
    const deploy = bodyOf(source, "edge-deploy");

    assert.ok(build.includes("deno task artefact:pack"), build);
    assert.ok(build.includes("include-hidden-files: true"), build);
    assert.ok(deploy.includes("uses: actions/download-artifact"), deploy);
    assert.ok(
      deploy.includes("deno task deploy:artefact"),
      "the deployment must use the deployment-only interface",
    );
  });

  it("cannot build in the deployment job", () => {
    if (source === null) return;
    const deploy = bodyOf(source, "edge-deploy");
    for (const command of BUILD_COMMANDS) {
      assert.ok(
        !deploy.includes(command),
        `the deployment job must not run ${command}`,
      );
    }
    assert.ok(!deploy.includes("VITE_PERMISSION_PROFILE"), deploy);
  });

  it("keeps credentials out of the build job", () => {
    if (source === null) return;
    const build = bodyOf(source, "edge-build");
    assert.ok(!build.includes("CLOUDFLARE_API_TOKEN"), build);
    assert.ok(!build.includes("CLOUDFLARE_ACCOUNT_ID"), build);
  });

  it("keeps the acceptance, cleanup and evidence steps in the deployment job", () => {
    if (source === null) return;
    const deploy = bodyOf(source, "edge-deploy");
    for (
      const step of [
        "Edge acceptance (real browser, real deployment)",
        "Delete the disposable Worker and verify it is gone",
        "Keep the acceptance evidence",
      ]
    ) {
      assert.ok(deploy.includes(step), `the deployment job must keep: ${step}`);
    }
  });

  it("needs no Node in the deployment path", () => {
    if (source === null) return;
    assert.ok(!source.includes("actions/setup-node"), source.slice(0, 0));
  });
});
