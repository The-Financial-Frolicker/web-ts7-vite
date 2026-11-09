/**
 * Deliberate toolchain provisioning for this laptop.
 *
 *   deno task toolchain:install                  materialise from the committed lock
 *   deno task toolchain:install --seed-from DIR   adopt an already-materialised tree
 *   deno task toolchain:install --print           report the resolved target only
 *
 * The operation is staged and then swapped into place, so an application never
 * sees a half-provisioned installation. `toolchain.json` is written last, inside
 * the staging directory: its presence is the readiness boundary and it records
 * the specification, resolution and materialisation identities.
 *
 * There is one current installation. Nothing here keeps history or a cache; an
 * old tree is removed after a successful swap.
 */

import { join } from "./lib/path.mjs";
import { readFileSync } from "./lib/fs.mjs";
import {
  assertDenoVersion,
  generatorInstallationRootPath,
  generatorPreviousPath,
  generatorProjectRoot,
  generatorStagingPath,
  generatorSubrootPath,
} from "./lib/toolchain/runtime.mjs";
import { MISE_TOOL_ID, readToolchainTuple } from "./contracts/toolchain.mjs";
import {
  digestOfFiles,
  fileDigest,
  treeDigest,
} from "./lib/toolchain/tree-digest.mjs";

export const TOOLCHAIN_SOURCE = "toolchain";
const SOURCE_FILES = Object.freeze(["package.json", "deno.json", "deno.lock"]);
const REQUIRED_PACKAGES = Object.freeze([
  "vite",
  "wrangler",
  "typescript",
  "@cloudflare/vite-plugin",
]);
const REQUIRED_FILES = Object.freeze([
  "node_modules/vite/bin/vite.js",
  "node_modules/wrangler/wrangler-dist/cli.js",
  "scripts/vite-runner.mjs",
]);

function fail(message) {
  throw new Error(`toolchain:install: ${message}`);
}

/** Remove a path when present; absence is not an error. */
function removeIfPresent(path) {
  try {
    Deno.removeSync(path, { recursive: true });
  } catch {
    // Nothing to remove.
  }
}

/** Recursive copy preserving modes and symlinks (no symlink is followed). */
export function copyTree(source, target) {
  const stat = Deno.lstatSync(source);
  if (stat.isSymlink) {
    Deno.symlinkSync(Deno.readLinkSync(source), target);
    return;
  }
  if (stat.isDirectory) {
    Deno.mkdirSync(target, { recursive: true });
    for (const entry of Deno.readDirSync(source)) {
      copyTree(join(source, entry.name), join(target, entry.name));
    }
    return;
  }
  Deno.copyFileSync(source, target);
  Deno.chmodSync(target, (stat.mode ?? 0o644) & 0o7777);
}

/** Move a directory when possible, copy otherwise. */
function moveTree(source, target) {
  try {
    Deno.renameSync(source, target);
  } catch {
    copyTree(source, target);
    Deno.removeSync(source, { recursive: true });
  }
}

/** Locate a package inside a materialised tree. */
export function findInstalledPackage(nodeModules, name) {
  const flat = join(nodeModules, name);
  try {
    if (Deno.statSync(flat).isDirectory) return flat;
  } catch {
    // Fall through to the content-addressed store.
  }

  const store = join(nodeModules, ".deno");
  let entries = [];
  try {
    entries = [...Deno.readDirSync(store)].map((entry) => entry.name).sort();
  } catch {
    fail(`no dependency tree at ${nodeModules}`);
  }

  for (const entry of entries) {
    const candidate = join(store, entry, "node_modules", name);
    try {
      if (Deno.statSync(candidate).isDirectory) return candidate;
    } catch {
      // Not this entry.
    }
  }

  fail(`${name} is missing from ${nodeModules}`);
}

/** Resolved versions the lock records for the direct dependencies. */
export function lockedVersions(lockText) {
  const lock = JSON.parse(lockText);
  const versions = {};
  for (const [specifier, resolved] of Object.entries(lock.specifiers ?? {})) {
    const match = /^npm:(.+?)@[^@]+$/.exec(specifier);
    if (match !== null) versions[match[1]] = resolved;
  }
  return versions;
}

/** Validate the staged tree and return the installed package versions. */
export function validateStaging(staging) {
  const nodeModules = join(staging, "node_modules");

  const installed = {};
  for (const name of REQUIRED_PACKAGES) {
    const dir = findInstalledPackage(nodeModules, name);
    installed[name] =
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
        .version;
  }

  for (const relative of REQUIRED_FILES) {
    const path = join(staging, relative);
    try {
      if (!Deno.statSync(path).isFile) fail(`${relative} is not a file`);
    } catch (error) {
      fail(`staged toolchain is incomplete: ${error.message}`);
    }
  }

  return installed;
}

/**
 * Resolve every path the installation will touch, with containment enforced.
 *
 * Pure: it creates nothing, so a rejected override fails before any mutation.
 * Every returned path is inside the generator-owned subroot.
 */
export function planInstallation({
  projectRoot = Deno.cwd(),
  env = Deno.env,
  pid = Deno.pid,
} = {}) {
  const generatorProject = generatorProjectRoot(projectRoot, env);
  const subroot = generatorSubrootPath(projectRoot, env);
  const target = generatorInstallationRootPath(projectRoot, env);
  const staging = generatorStagingPath(projectRoot, env, pid);
  const previous = generatorPreviousPath(projectRoot, env);

  for (
    const [label, candidate] of [
      ["the staging directory", staging],
      ["the previous installation path", previous],
    ]
  ) {
    if (candidate === target) {
      fail(`${label} must differ from the installation root ${target}`);
    }
  }

  return {
    generatorProjectRoot: generatorProject,
    subroot,
    target,
    staging,
    previous,
  };
}

/** CLI entry point; returns an exit code. */
/**
 * Toolchain *version* consistency, and the ownership debt it does not fix.
 *
 * A tuple member installed through mise's npm backend is a tool. The same
 * package also appears in this Deno dependency closure, because the Deno runners
 * execute the tools from here. That coexistence is an ownership defect, not a
 * design: the toolchain closure belongs to mise. It is not correct because the
 * versions happen to agree.
 *
 * `assertToolchainBoundary` therefore checks only what it can check: that no
 * copy in the closure has drifted from the tuple version, so two toolchains can
 * never be selected by whichever path ran first. `ownershipReport` records the
 * defect itself, so it is enumerated rather than tolerated.
 *
 * Removing the duplication requires the toolchain to be hosted from the mise
 * tree (feasibility established: Deno imports Vite from the mise installation
 * with its native bindings). That pivot also redefines what the installation
 * identity digests cover, so it is a separate, deliberate change.
 */
export function npmToolchainMembers(tuple) {
  const members = {};
  for (const tool of Object.keys(tuple)) {
    const id = MISE_TOOL_ID[tool];
    if (typeof id === "string" && id.startsWith("npm:")) {
      members[id.slice(4)] = tuple[tool];
    }
  }
  return members;
}

/** Fail unless the closure carries no second toolchain copy. */
/**
 * Enumerate toolchain packages present in the Deno dependency closure.
 *
 * Any entry is ownership debt: the toolchain closure belongs to mise. The report
 * exists so the debt is counted and cannot silently grow, and so the assertion
 * that it is empty becomes the acceptance gate once the tools are hosted from
 * the mise tree.
 */
export function ownershipReport({ tuple, inventory }) {
  const names = Object.keys(npmToolchainMembers(tuple));
  const present = names.filter((name) => (inventory?.[name] ?? []).length > 0);

  return {
    expectedOwners: names,
    ownedByDeno: present,
    violations: present.map((name) => ({
      name,
      versions: inventory[name],
      owner: "deno",
      requiredOwner: "mise",
    })),
    clean: present.length === 0,
  };
}

export function assertToolchainBoundary({ tuple, manifest, inventory }) {
  const members = npmToolchainMembers(tuple);
  const problems = [];
  const summary = [];

  for (const [name, version] of Object.entries(members)) {
    const declared = manifest?.[name];
    if (declared !== undefined && declared !== version) {
      problems.push(
        `${name} is declared as ${
          JSON.stringify(declared)
        } but the toolchain ` +
          `tuple fixes ${version}; toolchain components are specified exactly`,
      );
    }

    const found = inventory?.[name] ?? [];
    for (const installed of found) {
      if (installed !== version) {
        problems.push(
          `${name} ${installed} is installed in the Deno dependency tree, but ` +
            `the toolchain tuple fixes ${version}`,
        );
      }
    }

    summary.push({
      name,
      version,
      declared: declared ?? null,
      copies: found.length,
    });
  }

  if (problems.length > 0) {
    fail(problems.join("; "));
  }

  return summary;
}

/** Every version of each named package found anywhere under `nodeModules`. */
export function installedVersions(nodeModules, names) {
  const wanted = new Set(names);
  const found = Object.fromEntries(names.map((name) => [name, []]));

  function readVersion(directory) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      return typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      return null;
    }
  }

  function visit(directory, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = [...Deno.readDirSync(directory)];
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const child = join(directory, entry.name);
      if (wanted.has(entry.name)) {
        const version = readVersion(child);
        if (version !== null) found[entry.name].push(version);
      }
      // Package stores (`.deno/<pkg>@<ver>/node_modules/...`) and nested
      // `node_modules` trees both have to be walked: a second copy can be
      // reached either way.
      visit(child, depth + 1);
    }
  }

  visit(nodeModules, 0);
  return found;
}

export async function main(
  argv = Deno.args,
  appRoot = Deno.cwd(),
  env = Deno.env,
  io = console,
) {
  try {
    const seedIndex = argv.indexOf("--seed-from");
    const seedFrom = seedIndex === -1 ? undefined : argv[seedIndex + 1];

    // Every path is resolved and containment-checked before anything is
    // created, so an escaping override fails closed with no filesystem effect.
    const plan = planInstallation({ projectRoot: appRoot, env });
    const { target, staging, previous } = plan;

    if (argv.includes("--print")) {
      io.log(
        JSON.stringify({ ...plan, seedFrom: seedFrom ?? null }, null, 2),
      );
      return 0;
    }

    // 1. Definitions and pins.
    const deno = assertDenoVersion(appRoot);
    const sourceDir = join(appRoot, TOOLCHAIN_SOURCE);
    const texts = {};
    for (const name of SOURCE_FILES) {
      texts[name] = readFileSync(join(sourceDir, name), "utf8");
    }

    // 2. Staging: a sibling of the dependency tree, inside the same subroot, so
    // the final rename stays on one filesystem.
    removeIfPresent(staging);
    Deno.mkdirSync(staging, { recursive: true });
    for (const name of SOURCE_FILES) {
      Deno.writeTextFileSync(join(staging, name), texts[name]);
    }
    copyTree(join(sourceDir, "scripts"), join(staging, "scripts"));

    // 3. Materialise: from an existing tree (first migration) or from the lock.
    if (seedFrom !== undefined) {
      moveTree(seedFrom, join(staging, "node_modules"));
    } else {
      // A laptop normally has the ledger's packages in Deno's cache already, so
      // provisioning is `--cached-only` and cannot touch the network. A clean CI
      // runner has no such cache; `--allow-download` permits fetching the exact
      // locked artefacts. Resolution stays frozen either way: nothing is
      // discovered, upgraded or re-pinned.
      const allowDownload = argv.includes("--allow-download");
      const result = new Deno.Command(Deno.execPath(), {
        args: [
          "install",
          "--frozen",
          ...(allowDownload ? [] : ["--cached-only"]),
        ],
        cwd: staging,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "null",
      }).outputSync();
      if (result.code !== 0) {
        fail(
          "`deno install --frozen` failed in staging; the locked artefacts are " +
            "not available. Provisioning never resolves or upgrades.",
        );
      }
    }

    // 4. Validate before recording anything.
    const packages = validateStaging(staging);

    // The Deno tree must not carry a second copy of a toolchain component at a
    // version other than the tuple's. The tuple is read from the specification
    // mise installs from, so both boundaries are checked against one authority.
    const tuple = readToolchainTuple(appRoot);
    const members = npmToolchainMembers(tuple);
    const boundary = assertToolchainBoundary({
      tuple,
      manifest: JSON.parse(texts["package.json"]).dependencies ?? {},
      inventory: installedVersions(
        join(staging, "node_modules"),
        Object.keys(members),
      ),
    });
    const lock = lockedVersions(texts["deno.lock"]);
    for (const name of REQUIRED_PACKAGES) {
      const record = lock[name];
      if (record === undefined) continue;
      // A lock specifier can record a peer-resolved identity such as
      // `1.66.0_vite@8.3.5_wrangler@4.156.0`; only the version prefix is
      // comparable with an installed package version.
      const resolved = record.split("_")[0];
      if (resolved !== packages[name]) {
        fail(
          `${name} resolved ${packages[name]} but the lock records ${resolved}`,
        );
      }
    }

    // 5. Identity, written last.
    const materialisation = await treeDigest(join(staging, "node_modules"));
    const identity = {
      schema: 1,
      deno,
      platform: `${Deno.build.os}-${Deno.build.arch}`,
      spec: await digestOfFiles([
        {
          name: "package.json",
          digest: await fileDigest(join(staging, "package.json")),
        },
        {
          name: "deno.json",
          digest: await fileDigest(join(staging, "deno.json")),
        },
      ]),
      resolution: await fileDigest(join(staging, "deno.lock")),
      materialisation: materialisation.digest,
      // Cross-machine: the installed implementation without installer state.
      implementation: materialisation.implementationDigest,
      // Installer state, reported so a machine difference stays visible.
      metadata: {
        files: materialisation.metadataFiles,
        digest: materialisation.metadataDigest,
      },
      packages,
    };
    Deno.writeTextFileSync(
      join(staging, "toolchain.json"),
      `${JSON.stringify(identity, null, 2)}\n`,
    );

    // 6. Swap: one installation, no history, all inside the generator subroot.
    removeIfPresent(previous);
    let hadPrevious = false;
    try {
      Deno.renameSync(target, previous);
      hadPrevious = true;
    } catch {
      // First provision.
    }
    Deno.renameSync(staging, target);
    if (hadPrevious) removeIfPresent(previous);

    io.log(`toolchain: installed ${target}`);
    io.log(`toolchain: deno=${deno} packages=${JSON.stringify(packages)}`);
    for (const member of boundary) {
      io.log(
        `toolchain: boundary ${member.name}@${member.version} ` +
          `(declared ${member.declared ?? "not a dependency"}, ` +
          `${member.copies} copy(ies) in the Deno tree, mise owns the tool)`,
      );
    }
    io.log(`toolchain: materialisation=${materialisation.digest}`);
    return 0;
  } catch (error) {
    io.error(`toolchain: provisioning failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
