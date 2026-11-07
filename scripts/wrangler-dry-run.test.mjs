/**
 * Tests for the Deno-owned Wrangler dry-run invocation.
 *
 * These tests resolve the installed Wrangler CLI and esbuild, verify the
 * dry-run-specific permission profile, argument forwarding and exit-status
 * propagation. They do not execute a deployment or a real dry-run.
 */

import assert from "./lib/assert.mjs";
import { describe, it } from "./lib/test.mjs";
import {
  buildWranglerDryRunArgs,
  main,
  resolveWranglerDryRunInvocation,
  writablePaths,
} from "./wrangler-dry-run.mjs";

const projectRoot = Deno.cwd();
// Toolchain packages live in the installed toolchain, outside the application.
const toolchainRoot = Deno.env.get("TOOLCHAIN_ROOT") ??
  `${Deno.env.get("HOME")}/.local/share/web-ts7-vite/toolchain`;

describe("Deno-owned Wrangler dry-run", () => {
  it("resolves the direct Wrangler CLI and esbuild", () => {
    const invocation = resolveWranglerDryRunInvocation(toolchainRoot);

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
    const invocation = resolveWranglerDryRunInvocation(toolchainRoot);
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
