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
