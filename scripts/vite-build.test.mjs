/**
 * Tests for the Deno-owned Vite invocation.
 *
 * These tests resolve the installed package graph but do not run a production
 * build. They verify the two native bindings, the Vite CLI entry, both named
 * permission profiles, and the Bash wiring that selects one of them.
 */

import assert from "./lib/assert.mjs";
import { readFileSync } from "./lib/fs.mjs";
import path from "./lib/path.mjs";
import { describe, it } from "./lib/test.mjs";
import {
  buildViteArgs,
  findPackage,
  parseViteLauncherArgs,
  resolveViteBin,
  resolveViteInvocation,
} from "./vite-build.mjs";

const projectRoot = Deno.cwd();
const buildScript = path.join(projectRoot, "scripts", "build.sh");
const ciScript = path.join(projectRoot, "scripts", "ci.sh");
const dryRunScript = path.join(projectRoot, "scripts", "deploy-dry-run.sh");

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

  it("keeps the restricted local profile as the default", () => {
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

    // Naming the default explicitly must produce the same command line.
    assert.deepEqual(args, buildViteArgs(invocation, [], "local"));
  });

  it("gives the ci-runner profile --allow-all and keeps the pinned flags", () => {
    const invocation = resolveViteInvocation(projectRoot);
    const args = buildViteArgs(
      invocation,
      ["--mode", "production"],
      "ci-runner",
    );

    assert.ok(args.includes("--allow-all"), `missing --allow-all: ${args}`);
    assert.ok(
      args.includes("--cached-only"),
      `missing --cached-only: ${args}`,
    );
    assert.ok(args.includes("--frozen"), `missing --frozen: ${args}`);

    // --allow-all already implies every individual grant; repeating one would
    // describe a narrower profile than the one that runs.
    const individual = args.filter((argument) =>
      argument.startsWith("--allow-") && argument !== "--allow-all"
    );
    assert.deepEqual(individual, []);

    assert.deepEqual(args.slice(-4), [
      invocation.viteBin,
      "build",
      "--mode",
      "production",
    ]);
  });

  it("fails clearly for an unknown permission profile", () => {
    const invocation = resolveViteInvocation(projectRoot);

    assert.throws(
      () => buildViteArgs(invocation, [], "root"),
      /unknown Vite permission profile "root"; expected one of: local, ci-runner/,
    );
  });

  it("reads the profile name the launcher is given, not an ambient signal", () => {
    const options = parseViteLauncherArgs([
      "--permission-profile=ci-runner",
      "--mode",
      "production",
    ]);

    assert.deepEqual(options, {
      profile: "ci-runner",
      extraArgs: ["--mode", "production"],
      printProfile: false,
    });

    // Without a selection the launcher stays on the default profile.
    assert.equal(
      parseViteLauncherArgs(["--mode", "production"]).profile,
      "local",
    );
  });

  it("keeps the outer launcher restricted and passes the profile by name", () => {
    const text = readFileSync(buildScript, "utf8");
    const lines = text.split("\n");
    const marker = lines.findIndex((line) =>
      line.includes("scripts/vite-build.mjs")
    );
    assert.ok(marker > 0, "scripts/build.sh must invoke the Vite launcher");

    // Walk back to the `deno run \` line that starts the launcher invocation.
    let start = marker;
    while (start > 0 && !/^\s*deno run \\$/.test(lines[start])) start -= 1;
    assert.match(lines[start], /^\s*deno run \\$/, "deno run must launch it");

    const block = lines.slice(start, marker + 1).join("\n");

    assert.doesNotMatch(block, /--allow-all/);
    assert.doesNotMatch(
      block,
      /--allow-net|--allow-env|--allow-sys|--allow-ffi/,
    );
    assert.match(block, /--allow-read="\$PROJECT_ROOT,\$NODE_MODULES_REAL"/);
    assert.equal(
      block.match(/--allow-run/g)?.length,
      1,
      `exactly one --allow-run=: ${block}`,
    );
    assert.match(block, /--allow-run="\$DENO_BIN"/);
    assert.match(
      lines[marker + 1],
      /--permission-profile=\$VITE_PERMISSION_PROFILE/,
    );

    // An ordinary local build stays restricted: build.sh defaults to `local`
    // and never selects the CI profile itself.
    assert.match(
      text,
      /VITE_PERMISSION_PROFILE="\$\{VITE_PERMISSION_PROFILE:-local\}"/,
    );
    assert.doesNotMatch(text, /VITE_PERMISSION_PROFILE=ci-runner/);
  });

  it("selects ci-runner for both CI Vite builds and nothing else", () => {
    const script = readFileSync(ciScript, "utf8");
    const dryRun = readFileSync(dryRunScript, "utf8");

    // The CI stage builds twice: the initial build, then the rebuild performed
    // by deploy:dry-run. Both are Vite invocations and need the same profile.
    assert.match(script, /VITE_PERMISSION_PROFILE=ci-runner deno task build/);
    assert.match(
      script,
      /VITE_PERMISSION_PROFILE=ci-runner deno task deploy:dry-run/,
    );
    assert.equal(
      script.match(/VITE_PERMISSION_PROFILE=/g)?.length,
      2,
      "the CI profile is selected for the two CI builds only",
    );
    assert.doesNotMatch(script, /--allow-all/);

    // Keep the second override honest: it exists because the dry-run wrapper
    // rebuilds the application.
    assert.match(
      dryRun,
      /^deno task build$/m,
      "deploy-dry-run.sh must rebuild, which is why CI overrides its profile",
    );
  });

  it("fails clearly when an installed package is absent", () => {
    assert.throws(
      () => findPackage("/nonexistent-s7b-project", "vite"),
      /cannot resolve installed package "vite"/,
    );
  });
});
