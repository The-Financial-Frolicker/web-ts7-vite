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

import { dirname, join } from "./lib/path.mjs";
import { readFileSync } from "./lib/fs.mjs";
import {
  assertDenoVersion,
  toolchainRootPath,
} from "./lib/toolchain/runtime.mjs";
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

/** CLI entry point; returns an exit code. */
export async function main(
  argv = Deno.args,
  appRoot = Deno.cwd(),
  env = Deno.env,
  io = console,
) {
  try {
    const seedIndex = argv.indexOf("--seed-from");
    const seedFrom = seedIndex === -1 ? undefined : argv[seedIndex + 1];
    const target = toolchainRootPath(env);

    if (argv.includes("--print")) {
      io.log(JSON.stringify({ target, seedFrom: seedFrom ?? null }, null, 2));
      return 0;
    }

    // 1. Definitions and pins.
    const deno = assertDenoVersion(appRoot);
    const sourceDir = join(appRoot, TOOLCHAIN_SOURCE);
    const texts = {};
    for (const name of SOURCE_FILES) {
      texts[name] = readFileSync(join(sourceDir, name), "utf8");
    }

    // 2. Staging.
    const parent = dirname(target);
    Deno.mkdirSync(parent, { recursive: true });
    const staging = join(parent, `.staging-${Deno.pid}`);
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

    // 6. Swap: one installation, no history.
    const previous = `${target}.previous`;
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
