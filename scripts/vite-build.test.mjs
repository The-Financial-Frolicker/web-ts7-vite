/**
 * Tests for the Deno-owned Vite invocation.
 *
 * These tests resolve the installed package graph but do not run a production
 * build. They verify the two native bindings, the Vite CLI entry, and the exact
 * child-process permission profile.
 */

import assert from "./lib/assert.mjs";
import { describe, it } from "./lib/test.mjs";
import {
  buildViteArgs,
  findPackage,
  resolveViteBin,
  resolveViteInvocation,
} from "./vite-build.mjs";

const projectRoot = Deno.cwd();

describe("Deno-owned Vite invocation", () => {
  it("resolves the installed Vite CLI entry", () => {
    const viteBin = resolveViteBin(projectRoot);

    assert.ok(viteBin.endsWith("/vite/bin/vite.js"), viteBin);
    assert.ok(Deno.statSync(viteBin).isFile, `${viteBin} must be a file`);
  });

  it("resolves both required native bindings", () => {
    const invocation = resolveViteInvocation(projectRoot);

    assert.ok(
      invocation.rolldown.endsWith(".node") &&
        invocation.rolldown.includes("rolldown-binding"),
      invocation.rolldown,
    );
    assert.ok(
      invocation.lightningcss.endsWith(".node") &&
        invocation.lightningcss.includes("lightningcss"),
      invocation.lightningcss,
    );
    assert.ok(
      Deno.statSync(invocation.rolldown).isFile,
      `${invocation.rolldown} must be a file`,
    );
    assert.ok(
      Deno.statSync(invocation.lightningcss).isFile,
      `${invocation.lightningcss} must be a file`,
    );
  });

  it("grants only the explicit Vite build profile", () => {
    const invocation = resolveViteInvocation(projectRoot);
    const args = buildViteArgs(invocation);

    for (
      const required of [
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-sys",
        `--allow-ffi=${invocation.rolldown}`,
        `--allow-ffi=${invocation.lightningcss}`,
        "--cached-only",
        "--frozen",
      ]
    ) {
      assert.ok(args.includes(required), `missing ${required}: ${args}`);
    }

    assert.ok(
      !args.includes("--allow-run"),
      "Vite build must not have run access",
    );
    assert.ok(
      !args.includes("--allow-net"),
      "Vite build must not have net access",
    );
    assert.ok(
      !args.includes("--allow-all"),
      "Vite build must not have all access",
    );
    assert.equal(args.at(-1), "build");
  });

  it("fails clearly when an installed package is absent", () => {
    assert.throws(
      () => findPackage("/nonexistent-s7b-project", "vite"),
      /cannot resolve installed package "vite"/,
    );
  });
});
