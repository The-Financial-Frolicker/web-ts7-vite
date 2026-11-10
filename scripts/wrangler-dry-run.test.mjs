/**
 * Tests for the Deno-owned Wrangler dry-run invocation.
 *
 * These tests resolve the installed Wrangler CLI and esbuild, verify the
 * dry-run-specific permission profile, argument forwarding and exit-status
 * propagation. They do not execute a deployment or a real dry-run.
 */

import assert from "./lib/assert.mjs";
import { describe, it } from "./lib/test.mjs";
import { deploymentInstallationRoot } from "./lib/toolchain/runtime.mjs";
import {
  buildWranglerDryRunArgs,
  main,
  resolveWranglerDryRunInvocation,
  writablePaths,
} from "./wrangler-dry-run.mjs";

const projectRoot = Deno.cwd();
// The deployment installation, resolved through the same policy the launcher
// uses — so an explicit `DEPLOYMENT_ROOT` or `GENERATOR_PROJECT_ROOT` is honoured
// instead of a hard-coded path.
const deploymentTree = deploymentInstallationRoot(projectRoot);

describe("Deno-owned Wrangler dry-run", () => {
  it("resolves the direct Wrangler CLI and esbuild", () => {
    const invocation = resolveWranglerDryRunInvocation(deploymentTree);

    assert.ok(invocation.wranglerCli.endsWith("/wrangler-dist/cli.js"));
    assert.ok(
      !invocation.wranglerCli.endsWith("/bin/wrangler.js"),
      "must not resolve the npm Wrangler wrapper",
    );
    assert.ok(invocation.esbuild.endsWith("/bin/esbuild"));
    assert.ok(Deno.statSync(invocation.wranglerCli).isFile);
    assert.ok(Deno.statSync(invocation.esbuild).isFile);
  });

  it("builds the dry-run-specific profile and forwards arguments", () => {
    const invocation = resolveWranglerDryRunInvocation(
      deploymentTree,
    );
    const writes = writablePaths(projectRoot);
    const args = buildWranglerDryRunArgs(invocation, projectRoot, [
      "--var",
      "X:1",
    ]);

    for (
      const required of [
        "--allow-read",
        "--allow-env",
        "--allow-sys",
        `--allow-run=${invocation.esbuild}`,
        "--cached-only",
        "--no-lock",
        invocation.wranglerCli,
        "deploy",
        "--config",
        `${projectRoot}/dist/worker/wrangler.json`,
        "--dry-run",
        "--var",
        "X:1",
      ]
    ) {
      assert.ok(args.includes(required), `missing ${required}: ${args}`);
    }

    for (const write of writes) {
      assert.ok(args.includes(`--allow-write=${write}`));
    }

    assert.equal(args.at(-2), "--var");
    assert.equal(args.at(-1), "X:1");
    assert.ok(!args.includes("--allow-run"));
    assert.ok(!args.includes("--allow-net"));
    assert.ok(!args.includes("--allow-write"));
    assert.ok(!args.includes("--allow-ffi"));
    assert.ok(!args.includes("--allow-all"));
    assert.ok(!args.some((arg) => arg.includes("workerd")));
  });

  it("propagates the child process exit status", () => {
    assert.equal(main([], projectRoot, () => 7), 7);
  });

  it("returns a failure when the child cannot be executed", () => {
    assert.equal(
      main([], projectRoot, () => {
        throw new Error("Requires run access to the esbuild executable");
      }),
      1,
    );
  });

  it("fails clearly without an installed Wrangler package", () => {
    assert.throws(
      () => resolveWranglerDryRunInvocation("/nonexistent-s7d-project"),
      /cannot resolve installed package "wrangler"/,
    );
  });
});

// --- Deployment runtime boundary -------------------------------------------
//
// These cases exercise the launcher, not the policy: an incompatible or
// unresolved deployment runtime must prevent Wrangler from being executed at
// all. The executor is injected, so a test that reaches it is visible here.

function writeFixtureFile(root, relative, contents) {
  const file = `${root}/${relative}`;
  Deno.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  Deno.writeTextFileSync(file, contents);
}

function fixturePlatformPackage() {
  const osName = { win32: "windows" }[Deno.build.os] ?? Deno.build.os;
  const arch = { x86_64: "64", aarch64: "arm64", arm: "arm", ia32: "ia32" }[
    Deno.build.arch
  ] ?? Deno.build.arch;
  return `@cloudflare/workerd-${osName}-${arch}`;
}

/** A project root whose installation resolves (or fails to resolve) a runtime. */
function makeDeploymentRoot({ plugin = true, mismatch = false } = {}) {
  const root = Deno.realPathSync(
    Deno.makeTempDirSync({ prefix: "deploy-launcher-" }),
  );
  const installation = `${root}/generator/deployment`;
  const platform = fixturePlatformPackage();

  const write = (relative, contents) =>
    writeFixtureFile(installation, relative, contents);
  const pkg = (name, version, extra = {}) =>
    write(
      `.deno/${
        name.replaceAll("/", "+")
      }@${version}/node_modules/${name}/package.json`,
      JSON.stringify({ name, version, ...extra }),
    );

  writeFixtureFile(
    root,
    ".mise.toml",
    `[tools]\ndeno = "${Deno.version.deno}"\n`,
  );
  write(
    "deployment.json",
    JSON.stringify({
      schema: 1,
      deno: Deno.version.deno,
      spec: "s",
      resolution: "r",
      materialisation: "a".repeat(64),
      implementation: "b".repeat(64),
    }),
  );

  const wranglerMiniflare = "5.0.0";
  const pluginMiniflare = mismatch ? "5.1.0" : "5.0.0";
  const wranglerWorkerd = "1.0.0";
  const pluginWorkerd = mismatch ? "1.1.0" : "1.0.0";

  pkg("wrangler", "4.156.0", {
    dependencies: { miniflare: wranglerMiniflare },
  });
  if (plugin) {
    pkg("@cloudflare/vite-plugin", "1.66.0", {
      dependencies: { miniflare: pluginMiniflare },
    });
  }
  pkg("miniflare", wranglerMiniflare, {
    dependencies: { workerd: wranglerWorkerd },
  });
  pkg("workerd", wranglerWorkerd, {
    optionalDependencies: { [platform]: "1.0.0" },
  });
  if (mismatch) {
    pkg("miniflare", pluginMiniflare, {
      dependencies: { workerd: pluginWorkerd },
    });
    pkg("workerd", pluginWorkerd, {
      optionalDependencies: { [platform]: "1.0.0" },
    });
  }
  pkg(platform, "1.0.0");
  write(
    `.deno/${
      platform.replaceAll("/", "+")
    }@1.0.0/node_modules/${platform}/bin/workerd`,
    "#!/bin/sh\n",
  );

  return root;
}

function withDeploymentRoot(options, body) {
  const root = makeDeploymentRoot(options);
  try {
    return body(root);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
}

describe("deployment runtime enforcement", () => {
  it("runs the injected executor when the graphs are compatible", () => {
    // The real installation is compatible today, so the launcher must reach the
    // injected executor. Nothing is executed for real: the executor is a stub.
    let called = 0;
    const code = main([], Deno.cwd(), () => {
      called += 1;
      return 0;
    });
    assert.equal(code, 0);
    assert.equal(called, 1);
  });

  it("aborts before execution when the workerd versions differ", () => {
    withDeploymentRoot({ mismatch: true }, (root) => {
      let called = 0;
      const code = main([], root, () => {
        called += 1;
        return 0;
      });
      assert.equal(code, 1);
      assert.equal(called, 0, "the executor must not run");
    });
  });

  it("aborts before execution when a graph cannot be resolved", () => {
    withDeploymentRoot({ plugin: false }, (root) => {
      let called = 0;
      const code = main([], root, () => {
        called += 1;
        return 0;
      });
      assert.equal(code, 1);
      assert.equal(called, 0, "the executor must not run");
    });
  });
});
