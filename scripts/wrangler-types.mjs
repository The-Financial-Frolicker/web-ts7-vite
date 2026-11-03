/**
 * Deno-owned Wrangler type-generation launcher.
 *
 * This process does not import Wrangler. It resolves the installed Wrangler CLI
 * and the installed workerd executable, then spawns a separate Deno process
 * with an explicit permission profile:
 *
 *   read, write, env, sys, loopback-only net, and run access scoped to the
 *   exact workerd and esbuild executables.
 *
 * It grants no FFI permission, no broad network access and no all-permissions
 * access. esbuild is required because Wrangler uses it to resolve the Worker
 * main module while producing the project types; omitting it silently loses
 * the `Cloudflare.GlobalProps.mainModule` declaration. Wrangler dry-run and
 * deployment are deliberately outside this adapter.
 */

import { dirname, join } from "./lib/path.mjs";

function fail(message) {
  throw new Error(message);
}

function readJson(file, label) {
  let text;
  try {
    text = Deno.readTextFileSync(file);
  } catch (error) {
    fail(`cannot read ${label} at ${file}: ${error.message}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`cannot parse ${label} at ${file}: ${error.message}`);
  }
}

/** Return installed package candidates without relying on store hashes. */
function packageCandidates(root, name) {
  const candidates = [
    join(root, "node_modules", name, "package.json"),
  ];
  const store = join(root, "node_modules", ".deno");

  try {
    for (const entry of Deno.readDirSync(store)) {
      if (!entry.isDirectory) continue;
      candidates.push(
        join(store, entry.name, "node_modules", name, "package.json"),
      );
    }
  } catch {
    // A non-Deno layout may still provide the flat package above.
  }

  return candidates;
}

/** Read the locked version for a package, when deno.lock is available. */
function lockedVersion(root, name) {
  try {
    const lock = readJson(join(root, "deno.lock"), "deno.lock");
    const prefix = `${name}@`;
    for (const key of Object.keys(lock.npm ?? {})) {
      if (key.startsWith(prefix)) return key.slice(prefix.length);
    }
  } catch {
    // Resolution can still proceed from the installed package tree.
  }

  return undefined;
}

/** Find one installed package by its package.json name. */
export function findPackage(root, name) {
  const candidates = [];
  for (const file of packageCandidates(root, name)) {
    try {
      const json = readJson(file, `${name} package metadata`);
      if (json.name === name) {
        candidates.push({ directory: dirname(file), json, file });
      }
    } catch {
      // Missing candidate; try the next installed layout.
    }
  }

  if (candidates.length === 0) {
    fail(
      `cannot resolve installed package ${JSON.stringify(name)} under ` +
        `${join(root, "node_modules")}; run \`deno install --frozen\``,
    );
  }

  const wanted = lockedVersion(root, name);
  return wanted === undefined
    ? candidates[0]
    : candidates.find((candidate) => candidate.json.version === wanted) ??
      candidates[0];
}

/** Resolve the installed Wrangler package main entry point. */
export function resolveWranglerCli(root = Deno.cwd()) {
  const wrangler = findPackage(root, "wrangler");
  const main = wrangler.json.main;
  if (typeof main !== "string" || main.length === 0) {
    fail("installed wrangler package has no main entry");
  }

  const candidate = join(wrangler.directory, main);
  try {
    if (!Deno.statSync(candidate).isFile) {
      fail(`Wrangler CLI entry is not a file: ${candidate}`);
    }
    return Deno.realPathSync(candidate);
  } catch (error) {
    fail(`cannot resolve Wrangler CLI entry ${candidate}: ${error.message}`);
  }
}

/** Platform-specific package name for the installed workerd executable. */
function workerdPackageName() {
  const arch = {
    x86_64: "64",
    aarch64: "arm64",
  }[Deno.build.arch];
  if (arch === undefined) {
    fail(`unsupported workerd architecture: ${Deno.build.arch}`);
  }

  switch (Deno.build.os) {
    case "linux":
      return `@cloudflare/workerd-linux-${arch}`;
    case "darwin":
      return `@cloudflare/workerd-darwin-${arch}`;
    case "windows":
      return arch === "64"
        ? "@cloudflare/workerd-windows-64"
        : fail(`unsupported workerd architecture on Windows: ${arch}`);
    default:
      fail(`unsupported workerd platform: ${Deno.build.os}`);
  }
}

/** Resolve the installed workerd executable used by Wrangler types. */
export function resolveWorkerd(root = Deno.cwd()) {
  const packageName = workerdPackageName();
  const workerd = findPackage(root, packageName);
  const candidate = join(workerd.directory, "bin", "workerd");

  try {
    if (!Deno.statSync(candidate).isFile) {
      fail(`workerd executable is not a file: ${candidate}`);
    }
    return Deno.realPathSync(candidate);
  } catch (error) {
    fail(`cannot resolve workerd executable ${candidate}: ${error.message}`);
  }
}

/** Platform-specific package name for the installed esbuild executable. */
function esbuildPackageName() {
  const arch = {
    x86_64: "x64",
    aarch64: "arm64",
    arm: "arm",
    ia32: "ia32",
  }[Deno.build.arch];
  if (arch === undefined) {
    fail(`unsupported esbuild architecture: ${Deno.build.arch}`);
  }

  switch (Deno.build.os) {
    case "linux":
      return `@esbuild/linux-${arch}`;
    case "darwin":
      return `@esbuild/darwin-${arch}`;
    case "windows":
      return `@esbuild/win32-${arch}`;
    default:
      fail(`unsupported esbuild platform: ${Deno.build.os}`);
  }
}

/** Resolve the installed esbuild executable used by Wrangler types. */
export function resolveEsbuild(root = Deno.cwd()) {
  const packageName = esbuildPackageName();
  const esbuild = findPackage(root, packageName);
  const candidate = join(esbuild.directory, "bin", "esbuild");

  try {
    if (!Deno.statSync(candidate).isFile) {
      fail(`esbuild executable is not a file: ${candidate}`);
    }
    return Deno.realPathSync(candidate);
  } catch (error) {
    fail(`cannot resolve esbuild executable ${candidate}: ${error.message}`);
  }
}

/** Resolve the Wrangler CLI, workerd and esbuild executables. */
export function resolveWranglerTypesInvocation(root = Deno.cwd()) {
  return {
    wranglerCli: resolveWranglerCli(root),
    workerd: resolveWorkerd(root),
    esbuild: resolveEsbuild(root),
  };
}

/**
 * Build the separate-Deno-process command line for type generation.
 *
 * Network access is restricted to the loopback listener that Wrangler needs
 * while generating runtime types. Run access is scoped to the exact workerd
 * executable. No FFI permission or broad net access is granted.
 */
export function buildWranglerTypesArgs(invocation, extraArgs = []) {
  return [
    "run",
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
    ...extraArgs,
  ];
}

/** CLI entry point; returns a process exit code. */
export function main(argv = Deno.args, root = Deno.cwd()) {
  try {
    const invocation = resolveWranglerTypesInvocation(root);
    const extraArgs = argv[0] === "--print-profile" ? [] : argv;
    const args = buildWranglerTypesArgs(invocation, extraArgs);

    if (argv[0] === "--print-profile") {
      console.log(JSON.stringify({ ...invocation, args }, null, 2));
      return 0;
    }

    console.error(
      "Wrangler types: read/write/env/sys + loopback net + " +
        `run=${invocation.workerd}, run=${invocation.esbuild}; ` +
        "no FFI or all permissions",
    );

    const result = new Deno.Command(Deno.execPath(), {
      args,
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).outputSync();

    return result.code;
  } catch (error) {
    console.error(`Wrangler type generation failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = main();
}
