/**
 * Tests for the Deno-owned Wrangler deployment launcher's permission profile.
 *
 * The narrow write grant is the point: Wrangler needs its own temporary state
 * directory beside the generated deployment config, and nothing else in the
 * build output. A regression that widened this to `dist/worker` would let a
 * deployment write over the artefacts that `check:deploy` just verified.
 */

import assert from "./lib/assert.mjs";
import { describe, it } from "./lib/test.mjs";
import {
  buildWranglerDeployArgs,
  deployStatePaths,
} from "./wrangler-deploy.mjs";

const invocation = {
  wranglerCli: "<wrangler>",
  esbuild: "<esbuild>",
  appRoot: "/app",
  config: "/app/dist/worker/wrangler.json",
};

function granted(flag, args) {
  return args
    .filter((argument) => argument.startsWith(`${flag}=`))
    .map((argument) => argument.slice(flag.length + 1));
}

describe("Deno-owned Wrangler deploy launcher", () => {
  it("grants Wrangler's own state, never the build output", () => {
    const args = buildWranglerDeployArgs(invocation);

    assert.deepEqual(granted("--allow-write", args), [
      "/app/.wrangler",
      "/app/dist/worker/.wrangler",
    ]);
    assert.ok(
      !granted("--allow-write", args).includes("/app/dist/worker"),
      `the build output must not be writable: ${args}`,
    );
  });

  it("keeps network, process execution and permissions scoped", () => {
    const args = buildWranglerDeployArgs(invocation);

    assert.deepEqual(granted("--allow-net", args), ["api.cloudflare.com"]);
    assert.deepEqual(granted("--allow-run", args), ["<esbuild>"]);
    assert.ok(!args.includes("--allow-all"), "no broad permissions");
    assert.ok(args.includes("--cached-only"));
    assert.ok(args.includes("--no-lock"));
    // Default invocation deploys the generated config, not the source one.
    assert.deepEqual(args.slice(-3), [
      "deploy",
      "--config",
      "/app/dist/worker/wrangler.json",
    ]);
  });

  it("passes explicit arguments through for read-only queries", () => {
    const args = buildWranglerDeployArgs(invocation, [
      "deployments",
      "status",
      "--json",
    ]);

    assert.deepEqual(args.slice(-3), ["deployments", "status", "--json"]);
    // The profile is identical: a query is granted no more than a deploy.
    assert.deepEqual(granted("--allow-write", args), [
      "/app/.wrangler",
      "/app/dist/worker/.wrangler",
    ]);
  });

  it("names the temporary-state path the config directory implies", () => {
    assert.equal(
      deployStatePaths("/app").configState,
      "/app/dist/worker/.wrangler",
    );
    assert.equal(deployStatePaths("/app").logs, "/app/.wrangler/logs");
  });
});

import { main as deployMain } from "./wrangler-deploy.mjs";

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
  const installation = `${root}/generator/toolchain`;
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
    "toolchain.json",
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
  it("passes the runtime policy before any deployment work", () => {
    // Deployment needs a built artefact, which a bare checkout does not have, so
    // this launcher stops at artefact resolution rather than at the runtime
    // policy. What must hold here is that the policy itself does not reject a
    // compatible installation: the failure, if any, is never a runtime
    // incompatibility, and the executor is never reached.
    const original = console.error;
    const messages = [];
    console.error = (...args) => messages.push(args.join(" "));
    try {
      const code = deployMain([], Deno.cwd(), () => {
        messages.push("EXECUTOR-CALLED");
        return 0;
      });
      assert.equal(code, 1, "a bare checkout cannot deploy");
      const text = messages.join("\n");
      assert.doesNotMatch(text, /deployment runtime incompatible/);
      assert.doesNotMatch(text, /EXECUTOR-CALLED/);
    } finally {
      console.error = original;
    }
  });

  it("aborts before execution when the workerd versions differ", () => {
    withDeploymentRoot({ mismatch: true }, (root) => {
      let called = 0;
      const code = deployMain([], root, () => {
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
      const code = deployMain([], root, () => {
        called += 1;
        return 0;
      });
      assert.equal(code, 1);
      assert.equal(called, 0, "the executor must not run");
    });
  });
});
