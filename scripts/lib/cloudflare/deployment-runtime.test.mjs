/**
 * Tests for the deployment runtime compatibility policy.
 *
 * Fixtures are synthetic dependency trees, so the assertions test the policy and
 * the shared walk it delegates to, not this machine's installation.
 */
import assert from "../assert.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../fs.mjs";
import os from "../os.mjs";
import path from "../path.mjs";
import { after, describe, it } from "../test.mjs";
import {
  assertDeploymentRuntime,
  compareDeploymentRuntimes,
  DeploymentRuntimeError,
} from "./deployment-runtime.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = Deno.realPathSync(
    mkdtempSync(path.join(os.tmpdir(), "deploy-runtime-")),
  );
  roots.push(root);
  return root;
}

function write(root, relative, text) {
  const file = path.join(root, "node_modules", relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function platformPackage() {
  const osName = { win32: "windows" }[Deno.build.os] ?? Deno.build.os;
  const arch = { x86_64: "64", aarch64: "arm64", arm: "arm", ia32: "ia32" }[
    Deno.build.arch
  ] ?? Deno.build.arch;
  return `@cloudflare/workerd-${osName}-${arch}`;
}

/**
 * A tree with one Miniflare/workerd graph. `owners` lists the packages whose
 * manifest declares Miniflare; each extra owner makes the graph reachable.
 */
function makeTree(
  {
    miniflareVersion = "5.0.0",
    workerdVersion = "1.0.0",
    binary = true,
    owners = ["wrangler", "@cloudflare/vite-plugin"],
  } = {},
) {
  const root = tempRoot();
  const platform = platformPackage();

  for (const owner of owners) {
    write(
      root,
      `${owner}/package.json`,
      JSON.stringify({
        name: owner,
        version: "1.0.0",
        dependencies: { miniflare: miniflareVersion },
      }),
    );
  }
  write(
    root,
    "miniflare/package.json",
    JSON.stringify({
      name: "miniflare",
      version: miniflareVersion,
      dependencies: { workerd: workerdVersion },
    }),
  );
  write(
    root,
    "workerd/package.json",
    JSON.stringify({
      name: "workerd",
      version: workerdVersion,
      optionalDependencies: { [platform]: "1.0.0" },
    }),
  );
  write(
    root,
    `${platform}/package.json`,
    JSON.stringify({
      name: platform,
      version: "1.0.0",
    }),
  );
  if (binary) write(root, `${platform}/bin/workerd`, "#!/bin/sh\n");
  return root;
}

const runtime = (overrides) => ({
  packageName: "wrangler",
  packageVersion: "4.156.0",
  requiredBy: "wrangler@4.156.0",
  workerdVersion: "1.20261023.1",
  platformPackage: "@cloudflare/workerd-linux-64@1.20261023.1",
  binary: "/mise/workerd",
  ...overrides,
});

describe("deployment runtime policy", () => {
  it("accepts two graphs that select the same version and binary", () => {
    const result = compareDeploymentRuntimes(
      runtime(),
      runtime({
        packageName: "@cloudflare/vite-plugin",
        requiredBy: "@cloudflare/vite-plugin@1.66.0",
      }),
    );
    assert.equal(result.workerdVersion, "1.20261023.1");
    assert.equal(result.binary, "/mise/workerd");
    assert.deepEqual(result.graphs, [
      "wrangler@4.156.0",
      "@cloudflare/vite-plugin@1.66.0",
    ]);
  });

  it("rejects different workerd versions", () => {
    assert.throws(
      () =>
        compareDeploymentRuntimes(
          runtime(),
          runtime({
            packageName: "@cloudflare/vite-plugin",
            workerdVersion: "1.20261023.3",
          }),
        ),
      (error) =>
        error instanceof DeploymentRuntimeError &&
        /resolves workerd 1\.20261023\.1 but .* resolves 1\.20261023\.3/.test(
          error.message,
        ),
    );
  });

  it("rejects different canonical binaries at the same version", () => {
    assert.throws(
      () =>
        compareDeploymentRuntimes(
          runtime(),
          runtime({
            packageName: "@cloudflare/vite-plugin",
            binary: "/other/workerd",
          }),
        ),
      (error) =>
        error instanceof DeploymentRuntimeError &&
        /selects the binary at \/mise\/workerd while .* selects \/other\/workerd/
          .test(error.message),
    );
  });
});

describe("deployment runtime resolution", () => {
  it("accepts a coherent tree", () => {
    const result = assertDeploymentRuntime({ nodeModules: makeTree() });
    assert.equal(result.workerdVersion, "1.0.0");
    assert.match(result.binary, /bin\/workerd$/);
  });

  it("fails closed when the Wrangler graph is missing", () => {
    assert.throws(
      () =>
        assertDeploymentRuntime({
          nodeModules: makeTree({ owners: ["@cloudflare/vite-plugin"] }),
        }),
      (error) =>
        error instanceof DeploymentRuntimeError &&
        /wrangler dependency graph could not be resolved/.test(error.message),
    );
  });

  it("fails closed when the plugin graph is missing", () => {
    assert.throws(
      () =>
        assertDeploymentRuntime({
          nodeModules: makeTree({ owners: ["wrangler"] }),
        }),
      (error) =>
        error instanceof DeploymentRuntimeError &&
        /@cloudflare\/vite-plugin dependency graph could not be resolved/.test(
          error.message,
        ),
    );
  });

  it("fails closed when the platform package is missing", () => {
    const root = makeTree();
    rmSync(path.join(root, "node_modules", platformPackage()), {
      recursive: true,
      force: true,
    });
    assert.throws(
      () => assertDeploymentRuntime({ nodeModules: root }),
      (error) =>
        error instanceof DeploymentRuntimeError &&
        /could not be resolved/.test(error.message),
    );
  });

  it("fails closed when the platform binary is missing", () => {
    assert.throws(
      () =>
        assertDeploymentRuntime({ nodeModules: makeTree({ binary: false }) }),
      (error) =>
        error instanceof DeploymentRuntimeError &&
        /workerd executable is missing or unreadable/.test(error.message),
    );
  });

  it("fails closed when a graph is ambiguous", () => {
    const root = makeTree();
    // Two distinct store copies of the same miniflare version, and no flat entry:
    // the shared walk refuses to guess, so deployment must not proceed.
    rmSync(path.join(root, "node_modules", "miniflare"), {
      recursive: true,
      force: true,
    });
    for (const entry of ["a", "b"]) {
      const store = path.join(
        root,
        "node_modules",
        ".deno",
        `miniflare-${entry}`,
        "node_modules",
        "miniflare",
      );
      mkdirSync(store, { recursive: true });
      writeFileSync(
        path.join(store, "package.json"),
        JSON.stringify({
          name: "miniflare",
          version: "5.0.0",
          dependencies: { workerd: "1.0.0" },
        }),
      );
    }
    assert.throws(
      () => assertDeploymentRuntime({ nodeModules: root }),
      (error) =>
        error instanceof DeploymentRuntimeError &&
        /refusing to guess/.test(error.message),
    );
  });
});

describe("the real dependency tree", () => {
  it("has compatible Wrangler and plugin runtimes", () => {
    const result = assertDeploymentRuntime({
      nodeModules: path.join(Deno.cwd(), "generator", "dependencies"),
    });
    assert.match(result.workerdVersion, /^\d+\./);
    assert.match(result.binary, /bin\/workerd$/);
  });
});
