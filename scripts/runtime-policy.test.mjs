/**
 * Tests for the generator-owned installation roots and runtime policy.
 *
 * Load-bearing rules:
 *   * the running Deno must be the pinned one;
 *   * the Deno dependency tree belongs to the generator and lives inside
 *     `<generator project root>/generator/`;
 *   * every path the installer touches is containment-checked before mutation;
 *   * a temporary test-application copy reuses the generator's installation.
 */

import assert from "./lib/assert.mjs";
import { existsSync, readFileSync } from "./lib/fs.mjs";
import { join } from "./lib/path.mjs";
import { describe, it } from "./lib/test.mjs";
import {
  assertDenoVersion,
  GENERATOR_DEPENDENCIES,
  GENERATOR_SUBROOT,
  generatorInstallationRoot,
  generatorInstallationRootPath,
  generatorSubrootPath,
  installedIdentity,
  pinnedDenoVersion,
  runtimePolicy,
  RuntimePolicyError,
} from "./lib/toolchain/runtime.mjs";
import { isContained } from "./lib/toolchain/containment.mjs";
import { main as buildMain } from "./vite-build.mjs";
import { main as serverMain } from "./vite-server.mjs";
import { main as typesMain } from "./wrangler-types.mjs";
import { main as dryRunMain } from "./wrangler-dry-run.mjs";
import { main as deployMain } from "./wrangler-deploy.mjs";

const projectRoot = Deno.cwd();

describe("generator runtime policy", () => {
  it("reads the approved Deno version from the generator-owned projection", () => {
    const pinned = pinnedDenoVersion(projectRoot);
    assert.match(pinned, /^\d+\.\d+\.\d+/);
    assert.equal(pinned, Deno.version.deno);
  });

  it("accepts the pinned interpreter and rejects any other", () => {
    assert.equal(
      assertDenoVersion(projectRoot, Deno.version.deno),
      Deno.version.deno,
    );
    assert.throws(
      () => assertDenoVersion(projectRoot, "0.0.1-probe"),
      /pins Deno .*, but this process is Deno 0\.0\.1-probe/,
    );
  });

  it("fails loudly when the pin cannot be read", () => {
    assert.throws(
      () => pinnedDenoVersion("/nonexistent-toolchain-project"),
      /cannot read .*\.mise\.toml; the toolchain pin is unknown/,
    );
  });

  it("exposes a distinct error type for callers to classify", () => {
    try {
      assertDenoVersion(projectRoot, "0.0.1-probe");
      throw new Error("expected a RuntimePolicyError");
    } catch (error) {
      assert.ok(error instanceof RuntimePolicyError, String(error));
    }
  });

  it("returns the pin, the generator root and the identity from one call", () => {
    const policy = runtimePolicy(projectRoot);
    assert.equal(policy.deno, Deno.version.deno);
    assert.equal(
      policy.generatorInstallationRoot,
      Deno.realPathSync(generatorInstallationRootPath(projectRoot)),
    );
    assert.equal(policy.identity.deno, policy.deno);
  });

  it("is asserted by every external-tool launcher before it does any work", async () => {
    const badRoot = "/nonexistent-toolchain-project";
    const launchers = [
      ["vite-build", () => buildMain(["--print-profile"], badRoot)],
      ["vite-server", () => serverMain(["dev", "--print-profile"], badRoot)],
      ["wrangler-types", () => typesMain(["--print-profile"], badRoot)],
      ["wrangler-dry-run", () => dryRunMain(["--print-profile"], badRoot)],
      ["wrangler-deploy", () => deployMain(["--print-profile"], badRoot)],
    ];

    for (const [name, run] of launchers) {
      assert.equal(await run(), 1, `${name} must reject an unreadable pin`);
    }
  });
});

describe("installed generator dependencies", () => {
  it("resolve to a canonical real directory inside the generator subroot", () => {
    const root = generatorInstallationRoot(projectRoot);
    assert.equal(Deno.realPathSync(root), root);
    assert.ok(Deno.statSync(root).isDirectory, `${root} must be a directory`);
    assert.equal(Deno.lstatSync(root).isSymlink ?? false, false);
    assert.equal(
      root,
      join(
        Deno.realPathSync(projectRoot),
        GENERATOR_SUBROOT,
        GENERATOR_DEPENDENCIES,
      ),
    );
  });

  it("record an identity whose Deno matches this runtime", () => {
    const identity = installedIdentity(generatorInstallationRoot(projectRoot));
    assert.equal(identity.schema, 1);
    assert.equal(identity.deno, Deno.version.deno);
    assert.match(identity.materialisation, /^[0-9a-f]{64}$/);
    assert.equal(identity.packages.vite, "8.3.5");
  });

  it("stay out of the project root", () => {
    assert.equal(existsSync(join(projectRoot, "node_modules")), false);
    const root = generatorInstallationRoot(projectRoot);
    assert.ok(isContained(root, generatorSubrootPath(projectRoot)), root);
    assert.equal(
      readFileSync(join(root, "toolchain.json"), "utf8").includes(
        '"schema": 1',
      ),
      true,
    );
  });
});
