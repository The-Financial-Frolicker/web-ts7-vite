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
// The toolchain is installed outside the application tree; resolution uses it.
// The generator owns its Deno dependency tree inside its own subroot.
const generatorInstallationRoot = path.join(
  projectRoot,
  "generator",
  "toolchain",
);
const buildScript = path.join(projectRoot, "scripts", "build.sh");
const ciScript = path.join(projectRoot, "scripts", "ci.sh");
const dryRunScript = path.join(projectRoot, "scripts", "deploy-dry-run.sh");

describe("Deno-owned Vite invocation", () => {
  it("resolves the installed Vite CLI entry", () => {
    const viteBin = resolveViteBin(generatorInstallationRoot);

    assert.ok(viteBin.endsWith("/vite/bin/vite.js"), viteBin);
    assert.ok(Deno.statSync(viteBin).isFile, `${viteBin} must be a file`);
  });

  it("resolves both required native bindings", () => {
    const invocation = resolveViteInvocation(generatorInstallationRoot);

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

  it("grants every resolved copy of the native bindings", () => {
    const invocation = resolveViteInvocation(generatorInstallationRoot);
    const args = buildViteArgs(invocation);
    const grants = args
      .filter((argument) => argument.startsWith("--allow-ffi="))
      .map((argument) => argument.slice("--allow-ffi=".length));

    assert.deepEqual(grants, invocation.ffi);
    assert.ok(grants.includes(invocation.rolldown), grants.join(", "));
    assert.ok(grants.includes(invocation.lightningcss), grants.join(", "));

    // The Cloudflare plugin resolves its own Vite peer, which loads that
    // installation's copies of the same two binding packages. Granting only the
    // view's copies fails the build with "Requires ffi access to ...", so this
    // asserts the plugin installation contributes both.
    const pluginInstallation = Deno.realPathSync(
      path.join(generatorInstallationRoot, "plugin-installation"),
    );
    const fromPlugin = grants.filter((grant) =>
      grant.startsWith(`${pluginInstallation}/`)
    );
    assert.equal(
      fromPlugin.length,
      2,
      `the plugin installation's two bindings must be granted: ${grants}`,
    );
  });

  it("keeps the restricted local profile as the default", () => {
    const invocation = resolveViteInvocation(generatorInstallationRoot);
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
        "--no-lock",
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
    // The child runs the toolchain-owned runner, then the mode, then the root.
    assert.equal(args.at(-2), "build");
    assert.equal(args.at(-1), projectRoot);
    assert.ok(
      args.includes(invocation.runner),
      `build must run the toolchain-owned runner: ${args}`,
    );
    assert.ok(
      !args.includes(invocation.viteBin),
      "build must not invoke Vite's CLI, which would drop the plugin policy",
    );

    // Naming the default explicitly must produce the same command line.
    assert.deepEqual(args, buildViteArgs(invocation, [], "local", projectRoot));
  });

  it("gives the ci-runner profile --allow-all and keeps the pinned flags", () => {
    const invocation = resolveViteInvocation(generatorInstallationRoot);
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
    assert.ok(args.includes("--no-lock"), `missing --frozen: ${args}`);

    // --allow-all already implies every individual grant; repeating one would
    // describe a narrower profile than the one that runs.
    const individual = args.filter((argument) =>
      argument.startsWith("--allow-") && argument !== "--allow-all"
    );
    assert.deepEqual(individual, []);

    assert.deepEqual(args.slice(-5), [
      invocation.runner,
      "build",
      projectRoot,
      "--mode",
      "production",
    ]);
  });

  it("fails clearly for an unknown permission profile", () => {
    const invocation = resolveViteInvocation(generatorInstallationRoot);

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
      /--allow-net|--allow-sys|--allow-ffi|--allow-write/,
    );
    assert.match(block, /--allow-read="\$GENERATOR_READ_PATHS"/);
    // The grant is the project root plus the generator-owned installation.
    assert.match(
      text,
      /GENERATOR_READ_PATHS="\$PROJECT_ROOT,\$GENERATOR_ROOT"/,
    );
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

  it("selects ci-runner once, for the only Vite build the CI stage performs", () => {
    const script = readFileSync(ciScript, "utf8");
    const dryRun = readFileSync(dryRunScript, "utf8");

    // The CI build stage now builds exactly once. The deployment dry run moved to
    // the deployment phase, so it is neither a second Vite invocation nor a
    // reason to select the broader profile there.
    assert.match(script, /VITE_PERMISSION_PROFILE=ci-runner deno task build/);
    assert.equal(
      script.match(/VITE_PERMISSION_PROFILE=/g)?.length,
      1,
      "the CI profile is selected for the build the stage performs",
    );
    assert.doesNotMatch(
      script,
      /deno task deploy:dry-run|deno task deploy:artefact/,
      "the build stage must not run a deployment step",
    );
    assert.doesNotMatch(script, /--allow-all/);

    // The combined convenience path still rebuilds, which is why a caller may
    // override its profile; that is a developer path, not the CI stage's.
    assert.match(
      dryRun,
      /^deno task build$/m,
      "deploy-dry-run.sh must rebuild: it is the combined convenience path",
    );
  });

  it("fails clearly when an installed package is absent", () => {
    assert.throws(
      () => findPackage("/nonexistent-s7b-project", "vite"),
      /cannot resolve installed package "vite"/,
    );
  });
});
