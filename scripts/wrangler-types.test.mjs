/**
 * Tests for the Deno-owned Wrangler type-generation invocation.
 *
 * These tests resolve the installed Wrangler CLI, workerd and esbuild binaries,
 * and verify the exact child-process permission profile. They do not execute
 * type generation or change `worker-configuration.d.ts`.
 */

import assert from "./lib/assert.mjs";
import { describe, it } from "./lib/test.mjs";
import {
  buildWranglerTypesArgs,
  findPackage,
  resolveEsbuild,
  resolveWorkerd,
  resolveWranglerCli,
  resolveWranglerTypesInvocation,
} from "./wrangler-types.mjs";

const projectRoot = Deno.cwd();

describe("Deno-owned Wrangler type generation", () => {
  it("resolves the installed Wrangler CLI main entry", () => {
    const cli = resolveWranglerCli(projectRoot);

    assert.ok(cli.endsWith("/wrangler-dist/cli.js"), cli);
    assert.ok(Deno.statSync(cli).isFile, `${cli} must be a file`);
  });

  it("resolves the installed workerd and esbuild executables", () => {
    const invocation = resolveWranglerTypesInvocation(projectRoot);

    assert.ok(invocation.workerd.endsWith("/bin/workerd"), invocation.workerd);
    assert.ok(invocation.esbuild.endsWith("/bin/esbuild"), invocation.esbuild);
    assert.ok(Deno.statSync(invocation.workerd).isFile);
    assert.ok(Deno.statSync(invocation.esbuild).isFile);
    assert.equal(resolveWorkerd(projectRoot), invocation.workerd);
    assert.equal(resolveEsbuild(projectRoot), invocation.esbuild);
  });

  it("grants only the explicit Wrangler-types profile", () => {
    const invocation = resolveWranglerTypesInvocation(projectRoot);
    const args = buildWranglerTypesArgs(invocation, ["--check"]);

    for (
      const required of [
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-sys",
        "--allow-net=127.0.0.1",
        `--allow-run=${invocation.workerd}`,
        `--allow-run=${invocation.esbuild}`,
        "--cached-only",
        "--frozen",
        invocation.wranglerCli,
        "types",
        "worker-configuration.d.ts",
        "--config",
        "wrangler.jsonc",
        "--check",
      ]
    ) {
      assert.ok(args.includes(required), `missing ${required}: ${args}`);
    }

    assert.ok(!args.includes("--allow-run"));
    assert.ok(!args.includes("--allow-net"));
    assert.ok(!args.includes("--allow-ffi"));
    assert.ok(!args.includes("--allow-all"));
    assert.ok(!args.some((arg) => arg.startsWith("--allow-ffi=")));
  });

  it("fails clearly when an installed package is absent", () => {
    assert.throws(
      () => findPackage("/nonexistent-s7c-project", "wrangler"),
      /cannot resolve installed package "wrangler"/,
    );
    assert.throws(
      () => findPackage("/nonexistent-s7c-project", "workerd"),
      /cannot resolve installed package "workerd"/,
    );
  });
});
