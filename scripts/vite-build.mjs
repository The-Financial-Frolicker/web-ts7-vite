/**
 * Deno-owned Vite production-build launcher.
 *
 * This process does not import Vite. It resolves the installed Vite CLI and the
 * platform-specific Rolldown and Lightning CSS N-API bindings, then spawns a
 * separate Deno process with an explicit permission profile. The child process
 * receives only the permissions proven necessary for the production build:
 * read, write, env and sys, plus path-scoped FFI access to the two bindings.
 * It receives no run or net permission.
 *
 * FFI permission is not a native-code sandbox. It controls which libraries Deno
 * may load; once loaded, native code runs with the user's OS privileges.
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
  const selected = wanted === undefined
    ? candidates[0]
    : candidates.find((candidate) => candidate.json.version === wanted) ??
      candidates[0];

  return selected;
}

/** Resolve the installed Vite CLI entry point. */
export function resolveViteBin(root = Deno.cwd()) {
  const vite = findPackage(root, "vite");
  const bin = typeof vite.json.bin === "string"
    ? vite.json.bin
    : vite.json.bin?.vite;

  if (typeof bin !== "string" || bin.length === 0) {
    fail("installed vite package has no bin.vite entry");
  }

  const candidate = join(vite.directory, bin);
  try {
    if (!Deno.statSync(candidate).isFile) {
      fail(`Vite CLI entry is not a file: ${candidate}`);
    }
    return Deno.realPathSync(candidate);
  } catch (error) {
    fail(`cannot resolve Vite CLI entry ${candidate}: ${error.message}`);
  }
}

/** Platform suffix shared by the Rolldown and Lightning CSS binding names. */
function platformSuffix() {
  const arch = {
    x86_64: "x64",
    aarch64: "arm64",
    arm: "arm",
  }[Deno.build.arch];
  if (arch === undefined) {
    fail(`unsupported native-binding architecture: ${Deno.build.arch}`);
  }

  switch (Deno.build.os) {
    case "linux":
      return `linux-${arch}-${Deno.build.env === "musl" ? "musl" : "gnu"}`;
    case "darwin":
      return `darwin-${arch}`;
    case "windows":
      return `win32-${arch}-msvc`;
    default:
      fail(`unsupported native-binding platform: ${Deno.build.os}`);
  }
}

/** Resolve one platform binding package and its .node entry point. */
function resolveBinding(root, packageName) {
  const binding = findPackage(root, packageName);
  const main = binding.json.main;
  if (typeof main !== "string" || !main.endsWith(".node")) {
    fail(
      `installed ${packageName} package does not declare a .node main entry`,
    );
  }

  const candidate = join(binding.directory, main);
  try {
    if (!Deno.statSync(candidate).isFile) {
      fail(`native binding entry is not a file: ${candidate}`);
    }
    return Deno.realPathSync(candidate);
  } catch (error) {
    fail(`cannot resolve native binding ${candidate}: ${error.message}`);
  }
}

/** Resolve the Vite CLI and both required native bindings. */
export function resolveViteInvocation(root = Deno.cwd()) {
  const suffix = platformSuffix();
  const rolldown = resolveBinding(
    root,
    `@rolldown/binding-${suffix}`,
  );
  const lightningcss = resolveBinding(
    root,
    `lightningcss-${suffix}`,
  );

  return {
    viteBin: resolveViteBin(root),
    rolldown,
    lightningcss,
  };
}

/**
 * Build the separate-Deno-process command line.
 *
 * No --allow-run or --allow-net is included. FFI is scoped to the two exact
 * installed native libraries.
 */
export function buildViteArgs(invocation, extraArgs = []) {
  return [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "--allow-sys",
    `--allow-ffi=${invocation.rolldown}`,
    `--allow-ffi=${invocation.lightningcss}`,
    "--cached-only",
    "--frozen",
    invocation.viteBin,
    "build",
    ...extraArgs,
  ];
}

/** CLI entry point; returns a process exit code. */
export function main(argv = Deno.args, root = Deno.cwd()) {
  try {
    const invocation = resolveViteInvocation(root);
    const extraArgs = argv[0] === "--print-profile" ? [] : argv;
    const args = buildViteArgs(invocation, extraArgs);

    if (argv[0] === "--print-profile") {
      console.log(JSON.stringify({ ...invocation, args }, null, 2));
      return 0;
    }

    console.error(
      "Vite build: read/write/env/sys + " +
        `FFI=${invocation.rolldown}, FFI=${invocation.lightningcss}; ` +
        "no run or net permission",
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
    console.error(`Vite build invocation failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = main();
}
