/**
 * Deno-owned Vite production-build launcher.
 *
 * This process does not import Vite. It resolves the installed Vite CLI and the
 * platform-specific Rolldown and Lightning CSS N-API bindings, then spawns a
 * separate Deno process with an explicitly selected permission profile.
 *
 * Two profiles exist, and the caller chooses one by name:
 *
 *   local (default)
 *       The profile every developer machine uses: read, write, env and sys,
 *       plus path-scoped FFI access to the two native bindings. It receives no
 *       run or net permission.
 *
 *   ci-runner
 *       `--allow-all`, for the throwaway build on an ephemeral trusted CI
 *       runner. Deno's sandbox currently fails Vite's Linux platform detection
 *       when it probes special procfs paths such as
 *       `/proc/sys/fs/binfmt_misc/WSLInterop` under scoped permissions
 *       (denoland/deno#37062). The broader grant is confined to this separate
 *       child process and is only ever selected explicitly.
 *
 * The profile is never inferred from `CI` or any other ambient variable: the
 * launcher receives the name it was given, and an unknown name is an error.
 *
 * FFI permission is not a native-code sandbox. It controls which libraries Deno
 * may load; once loaded, native code runs with the user's OS privileges.
 */

import { dirname, join } from "./lib/path.mjs";

/** Named permission profiles for the separate Vite process. */
export const VITE_PERMISSION_PROFILES = Object.freeze(["local", "ci-runner"]);

/** The profile used when the caller names none. */
export const DEFAULT_VITE_PERMISSION_PROFILE = "local";

/** CLI flag that selects a profile explicitly. */
export const PERMISSION_PROFILE_FLAG = "--permission-profile";

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
 * Permission flags for one named profile.
 *
 * `ci-runner` deliberately adds no individual grants next to `--allow-all`:
 * repeating them would suggest a narrower profile than the one that runs.
 */
function permissionFlags(profile, invocation) {
  switch (profile) {
    case "local":
      return [
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-sys",
        `--allow-ffi=${invocation.rolldown}`,
        `--allow-ffi=${invocation.lightningcss}`,
      ];
    case "ci-runner":
      return ["--allow-all"];
    default:
      return fail(
        `unknown Vite permission profile ${JSON.stringify(profile)}; ` +
          `expected one of: ${VITE_PERMISSION_PROFILES.join(", ")}`,
      );
  }
}

/**
 * Build the separate-Deno-process command line for a named profile.
 *
 * The default is the restricted `local` profile. `--cached-only` and `--frozen`
 * are kept in every profile: a broader permission grant never means resolving
 * or fetching dependencies at build time.
 */
export function buildViteArgs(
  invocation,
  extraArgs = [],
  profile = DEFAULT_VITE_PERMISSION_PROFILE,
) {
  return [
    "run",
    ...permissionFlags(profile, invocation),
    "--cached-only",
    "--frozen",
    invocation.viteBin,
    "build",
    ...extraArgs,
  ];
}

/** Describe the grants the selected profile actually contains. */
export function describeViteProfile(profile, invocation) {
  switch (profile) {
    case "local":
      return "Vite build (profile local): read/write/env/sys + " +
        `FFI=${invocation.rolldown}, FFI=${invocation.lightningcss}; ` +
        "no run or net permission";
    case "ci-runner":
      return "Vite build (profile ci-runner): --allow-all for this separate " +
        "child process only; ephemeral CI runner, local profile unchanged";
    default:
      return fail(
        `unknown Vite permission profile ${JSON.stringify(profile)}; ` +
          `expected one of: ${VITE_PERMISSION_PROFILES.join(", ")}`,
      );
  }
}

/** Split the CLI arguments into the profile selection and Vite's own flags. */
export function parseViteLauncherArgs(argv) {
  const options = {
    profile: DEFAULT_VITE_PERMISSION_PROFILE,
    extraArgs: [],
    printProfile: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--print-profile") {
      options.printProfile = true;
      continue;
    }

    if (argument === PERMISSION_PROFILE_FLAG) {
      const value = argv[index + 1];
      if (value === undefined) {
        fail(`${PERMISSION_PROFILE_FLAG} requires a profile name`);
      }
      options.profile = value;
      index += 1;
      continue;
    }

    if (argument.startsWith(`${PERMISSION_PROFILE_FLAG}=`)) {
      options.profile = argument.slice(`${PERMISSION_PROFILE_FLAG}=`.length);
      continue;
    }

    options.extraArgs.push(argument);
  }

  return options;
}

/** CLI entry point; returns a process exit code. */
export function main(argv = Deno.args, root = Deno.cwd()) {
  try {
    const { profile, extraArgs, printProfile } = parseViteLauncherArgs(argv);
    const invocation = resolveViteInvocation(root);
    const args = buildViteArgs(invocation, extraArgs, profile);

    if (printProfile) {
      console.log(JSON.stringify({ ...invocation, profile, args }, null, 2));
      return 0;
    }

    console.error(describeViteProfile(profile, invocation));

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
