/**
 * Tests for the toolchain runtime policy.
 *
 * Two rules, both load-bearing: the running Deno must be the pinned one, and the
 * toolchain must be found at its installed location as a real directory. Every
 * external-tool launcher asserts both before doing any work.
 */

import assert from "./lib/assert.mjs";
import { join } from "./lib/path.mjs";
import { describe, it } from "./lib/test.mjs";
import {
  assertDenoVersion,
  installedIdentity,
  pinnedDenoVersion,
  runtimePolicy,
  RuntimePolicyError,
  toolchainRoot,
  toolchainRootPath,
} from "./lib/toolchain/runtime.mjs";
import { main as buildMain } from "./vite-build.mjs";
import { main as serverMain } from "./vite-server.mjs";
import { main as typesMain } from "./wrangler-types.mjs";
import { main as dryRunMain } from "./wrangler-dry-run.mjs";
import { main as deployMain } from "./wrangler-deploy.mjs";

const projectRoot = Deno.cwd();
// The toolchain is installed outside the application tree; resolution uses it.
const toolchainRootPathEnv = Deno.env.get("TOOLCHAIN_ROOT") ??
  `${Deno.env.get("HOME")}/.local/share/web-ts7-vite/toolchain`;

function fakeEnv(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get: (name) => map.get(name),
    toObject: () => Object.fromEntries(map),
  };
}

describe("toolchain runtime policy", () => {
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

  it("resolves the configured installation path without requiring it", () => {
    assert.equal(
      toolchainRootPath(fakeEnv({ TOOLCHAIN_ROOT: "/opt/tc" })),
      "/opt/tc",
    );
    assert.equal(
      toolchainRootPath(fakeEnv({ XDG_DATA_HOME: "/xdg" })),
      "/xdg/web-ts7-vite/toolchain",
    );
    assert.equal(
      toolchainRootPath(fakeEnv({ HOME: "/home/dev" })),
      "/home/dev/.local/share/web-ts7-vite/toolchain",
    );
    assert.throws(
      () => toolchainRootPath(fakeEnv({})),
      /cannot determine the toolchain installation root/,
    );
  });

  it("resolves the installation to a canonical real directory", () => {
    const root = toolchainRoot(
      fakeEnv({ TOOLCHAIN_ROOT: toolchainRootPathEnv }),
    );
    assert.ok(root.startsWith("/"), root);
    assert.equal(Deno.realPathSync(root), root);
    assert.ok(Deno.statSync(root).isDirectory, `${root} must be a directory`);
    // A symlinked installation would defeat path-scoped permission grants.
    assert.equal(Deno.lstatSync(root).isSymlink ?? false, false);
  });

  it("reports an absent installation instead of guessing", () => {
    assert.throws(
      () =>
        toolchainRoot(fakeEnv({ TOOLCHAIN_ROOT: "/nonexistent-toolchain" })),
      /toolchain installation is not installed at \/nonexistent-toolchain/,
    );
  });

  it("records an identity whose Deno matches this runtime", () => {
    const identity = installedIdentity(toolchainRootPathEnv);
    assert.equal(identity.schema, 1);
    assert.equal(identity.deno, Deno.version.deno);
    assert.match(identity.materialisation, /^[0-9a-f]{64}$/);
    assert.equal(identity.packages.vite, "8.3.5");
  });

  it("returns the pin, the root and the identity from one call", () => {
    const policy = runtimePolicy(projectRoot);
    assert.equal(policy.deno, Deno.version.deno);
    assert.equal(policy.toolchainRoot, Deno.realPathSync(toolchainRootPathEnv));
    assert.equal(policy.identity.deno, policy.deno);
  });

  it("exposes a distinct error type for callers to classify", () => {
    try {
      assertDenoVersion(projectRoot, "0.0.1-probe");
      throw new Error("expected a RuntimePolicyError");
    } catch (error) {
      assert.ok(error instanceof RuntimePolicyError, String(error));
    }
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

  it("keeps the toolchain outside the application tree", () => {
    const root = toolchainRoot(
      fakeEnv({ TOOLCHAIN_ROOT: toolchainRootPathEnv }),
    );
    assert.ok(
      !root.startsWith(join(projectRoot, "node_modules")),
      "the installation must not live in the application dependency tree",
    );

    let applicationTree = false;
    try {
      applicationTree = Deno.lstatSync(join(projectRoot, "node_modules"))
        .isDirectory;
    } catch {
      applicationTree = false;
    }
    assert.equal(
      applicationTree,
      false,
      "the application root must not carry a dependency tree of its own here",
    );
  });
});
