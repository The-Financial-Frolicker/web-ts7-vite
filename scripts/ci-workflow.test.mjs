/**
 * CI workflow contract tests (S7-D).
 *
 * Structural by design: the workflow is the ownership boundary, so these
 * assertions read the shipped file. They can prove that the two repository roles
 * are mutually exclusive, that the product path gates every task behind
 * provenance verification, and that no generator-only task leaks into it.
 */

import assert from "./lib/assert.mjs";
import { readFileSync } from "./lib/fs.mjs";
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
      body.includes("--generator") && body.includes("--toolchain-root"),
      "the verifier must receive the verified checkout and the installation root",
    );
  });

  it("provisions outside the product checkout, without implicit installation", () => {
    assert.ok(body.includes("TOOLCHAIN_ROOT:"), "TOOLCHAIN_ROOT must be set");
    assert.ok(
      body.includes("${{ runner.temp }}/toolchain"),
      "the installation must live outside the product checkout",
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
        "toolchain:prepare",
      ]
    ) {
      assert.ok(
        !body.includes(forbidden),
        `the product job must not run generator-only task ${forbidden}`,
      );
    }
  });

  describe("workflow YAML strictness", () => {
    it("accepts every shipped workflow with a duplicate-key-rejecting reader", () => {
      for (
        const name of [
          "ci.yml",
          "authoritative-toolchain.yml",
          "edge-acceptance.yml",
        ]
      ) {
        const source = readFileSync(
          path.join(Deno.cwd(), ".github", "workflows", name),
          "utf8",
        );
        assert.equal(
          findDuplicateMappingKey(source, name),
          null,
          `${name} must contain no duplicate mapping keys`,
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

  const JOB_NAMES = ["classify", "validate", "build", "product"];

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
      for (const name of JOB_NAMES) {
        for (const entry of jobDeclarations(name)) {
          if (entry.key !== "if") continue;
          assert.ok(
            !entry.value.includes("hashFiles("),
            `job ${name} uses hashFiles() in a job-level if (line ${entry.line})`,
          );
        }
      }
    });

    it("never uses the runner context in a job-level env", () => {
      for (const name of JOB_NAMES) {
        for (const entry of jobDeclarations(name)) {
          if (entry.key !== "env") continue;
          const text = [entry.value, ...entry.block].join("\n");
          assert.ok(
            !/\brunner\b/.test(text),
            `job ${name} uses the runner context in a job-level env (line ${entry.line})`,
          );
        }
      }
    });

    it("still permits those contexts where GitHub allows them", () => {
      // A step-level `runner` reference is exactly what the product job relies on.
      assert.ok(
        jobBody("product").includes(
          "TOOLCHAIN_ROOT: ${{ runner.temp }}/toolchain",
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
      "      TOOLCHAIN_ROOT: ${{ runner.temp }}/toolchain",
      "    steps:",
      "      - name: legitimate step",
      "        if: hashFiles('toolchain/deno.lock') != ''",
      "        env:",
      "          TOOLCHAIN_ROOT: ${{ runner.temp }}/toolchain",
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
});
