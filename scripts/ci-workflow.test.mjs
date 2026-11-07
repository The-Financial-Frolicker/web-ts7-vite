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

const MARKER = "hashFiles('toolchain/deno.lock')";

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
  it("gates every job on the generator-owned toolchain lock", () => {
    for (const name of ["validate", "build", "product"]) {
      assert.ok(
        jobCondition(name).includes(MARKER),
        `job ${name} does not discriminate on ${MARKER}`,
      );
    }
  });

  it("makes the generator and product roles mutually exclusive", () => {
    const generator = ["validate", "build"].map(jobCondition);
    const product = jobCondition("product");

    for (const condition of generator) {
      assert.ok(condition.includes("!= ''"), condition);
      assert.ok(!condition.includes("== ''"), condition);
    }
    assert.ok(product.includes("== ''"), product);
    assert.ok(!product.includes("!= ''"), product);
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
});
