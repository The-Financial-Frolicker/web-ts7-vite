/**
 * The toolchain installation: mise owns the packages, this operation owns the
 * resolution view and the certificate.
 *
 *   deno task toolchain:install            materialise the view and certify it
 *   deno task toolchain:install --print    report the plan only
 *
 * mise installs and owns Deno, Vite, Wrangler, Emscripten, TypeScript, CMake,
 * Ninja and the Cloudflare Vite plugin, with their complete closures. Nothing is
 * copied and nothing is installed here. Deno's Node-API loader needs a
 * `node_modules` topology it can walk, so this operation materialises a *view*:
 * one symlink per package, every target inside the mise installation.
 *
 * The view is resolution infrastructure, not ownership. `toolchain.json` records
 * the four-member tuple, what mise declares, what was actually resolved, a
 * content-based portable implementation digest of the installed packages, and a
 * digest of the view's structure — so the certificate survives a move between
 * machines and still detects a view that no longer represents the installation.
 *
 * The Deno dependency tree is no longer part of the toolchain. An application
 * that declares libraries of its own would get one; this one declares none.
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
  TOOLCHAIN_RECORD,
} from "./lib/toolchain/runtime.mjs";
import {
  MISE_TOOL_ID,
  readMisePins,
  readToolchainTuple,
} from "./contracts/toolchain.mjs";
import {
  createResolutionView,
  implementationDigest,
  miseDataDirectory,
  nativeBinding,
  toolClosure,
  unionClosure,
  viewDigest,
} from "./lib/toolchain/mise.mjs";
import { fileDigest } from "./lib/toolchain/tree-digest.mjs";

/** The view root, beside the deployment tree: `<generator subroot>/toolchain`. */
export const TOOLCHAIN_VIEW = "toolchain";

/**
 * The npm tools whose closures the view must resolve, with the closure depth
 * each one needs. Depth is per tool because it is a property of the dependency
 * graph, not a house style: Wrangler reaches `@img/sharp-*` five levels down.
 */
export const NPM_TOOLS = Object.freeze([
  { name: "vite", depth: 3, bindings: ["rolldown", "lightningcss"] },
  { name: "typescript", depth: 3, bindings: [] },
  { name: "wrangler", depth: 5, bindings: [] },
  { name: "@cloudflare/vite-plugin", depth: 4, bindings: [] },
]);

/** Paths that must resolve through the view for the qualified tools to run. */
export const REQUIRED_ENTRIES = Object.freeze([
  "node_modules/vite/bin/vite.js",
  "node_modules/wrangler/wrangler-dist/cli.js",
  "node_modules/@cloudflare/vite-plugin/dist/index.mjs",
]);

/** The Vite child's runner: toolchain-owned code, copied beside the view. */
export const RUNNER_FILES = Object.freeze([
  "vite-runner.mjs",
  "vite-probe.mjs",
]);
export const RUNNER_SOURCE = "toolchain";

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
/**
 * Validate the materialised view before it is recorded.
 *
 * Four questions, all about the view actually representing the certified tools:
 * the entry points the launchers execute resolve; every required tool is linked;
 * every link points inside the mise installation; and the native bindings the
 * Vite child loads are present as real files.
 */
export function validateView(viewRoot, packages, bindings) {
  for (const relative of REQUIRED_ENTRIES) {
    const path = join(viewRoot, relative);
    let stat;
    try {
      stat = Deno.statSync(path);
    } catch (error) {
      fail(`the view does not resolve ${relative}: ${error.message}`);
    }
    if (!stat.isFile) {
      fail(`${relative} resolves to something that is not a file`);
    }
  }

  const nodeModules = join(viewRoot, "node_modules");
  for (const tool of NPM_TOOLS) {
    let stat;
    try {
      stat = Deno.statSync(join(nodeModules, ...tool.name.split("/")));
    } catch {
      fail(`the view does not resolve npm:${tool.name}`);
    }
    if (!stat.isDirectory) {
      fail(`npm:${tool.name} does not resolve to a directory`);
    }
  }

  // No package may come from anywhere but mise: every resolved directory must
  // live inside the mise installation tree.
  const data = Deno.realPathSync(miseDataDirectory());
  for (const entry of packages) {
    let directory;
    try {
      directory = Deno.realPathSync(entry.directory);
    } catch (error) {
      fail(`cannot resolve ${entry.name}@${entry.version}: ${error.message}`);
    }
    if (!directory.startsWith(`${data}/`)) {
      fail(
        `${entry.name}@${entry.version} resolves outside the mise installation ` +
          `(${directory}); the view may only resolve mise-owned packages`,
      );
    }
  }

  for (const binding of bindings) {
    try {
      if (!Deno.statSync(binding.addon).isFile) {
        fail(`${binding.package} has no .node file`);
      }
    } catch (error) {
      fail(`native binding for ${binding.owner} is missing: ${error.message}`);
    }
  }
}

/**
 * Resolve every path the installation will touch, with containment enforced.
 *
 * Pure: it creates nothing, so a rejected override fails before any mutation.
 */
export function planInstallation({
  projectRoot = Deno.cwd(),
  env = Deno.env,
  pid = Deno.pid,
} = {}) {
  const generatorProject = generatorProjectRoot(projectRoot, env);
  const subroot = generatorSubrootPath(projectRoot, env);
  // Resolved through the shared policy so the override is still containment-
  // checked and still refuses the application-owned subtree.
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

/**
 * The declared npm tools, as `.mise.toml` pins them.
 *
 * `.mise.toml` is the authority for installed versions; a tool the project needs
 * but the specification does not declare is a specification defect, not a thing
 * to resolve from somewhere else.
 */
export function declaredTools(pins) {
  const declared = {};
  for (const tool of NPM_TOOLS) {
    const id = `npm:${tool.name}`;
    const version = pins[id];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
      fail(
        `.mise.toml declares no exact ${id} version; the toolchain ` +
          `specification is incomplete`,
      );
    }
    declared[tool.name] = version;
  }
  return declared;
}

/** CLI entry point; returns an exit code. */
export async function main(
  argv = Deno.args,
  appRoot = Deno.cwd(),
  env = Deno.env,
  io = console,
) {
  try {
    const plan = planInstallation({ projectRoot: appRoot, env });
    const { target, staging, previous } = plan;

    if (argv.includes("--print")) {
      io.log(JSON.stringify(plan, null, 2));
      return 0;
    }

    // 1. What is declared, and which Deno must be running.
    const deno = assertDenoVersion(appRoot);
    const tuple = readToolchainTuple(appRoot);
    const pins = readMisePins(appRoot);
    const declared = declaredTools(pins);

    // 2. Resolve the closures from the mise installations. A tool mise has not
    //    installed fails here, with the command that installs it; nothing falls
    //    back to a Deno tree.
    const closures = NPM_TOOLS.map((tool) =>
      toolClosure(tool.name, declared[tool.name], env, tool.depth)
    );
    const packages = unionClosure(closures);

    const bindings = [];
    for (const tool of NPM_TOOLS) {
      for (const owner of tool.bindings) {
        bindings.push(nativeBinding(packages, owner));
      }
    }

    // 3. Stage the view: symlinks only, next to the tree it will replace.
    removeIfPresent(staging);
    Deno.mkdirSync(staging, { recursive: true });
    const view = createResolutionView(staging, packages);
    const runnerDirectory = join(appRoot, RUNNER_SOURCE, "scripts");
    Deno.mkdirSync(join(staging, "scripts"), { recursive: true });
    for (const file of RUNNER_FILES) {
      copyTree(join(runnerDirectory, file), join(staging, "scripts", file));
    }

    // 4. Validate before recording anything.
    validateView(staging, packages, bindings);

    // 5. Identity, written last. Three separate evidence categories:
    //    what is declared, what resolved, and what the bytes actually are.
    const implementation = await implementationDigest(packages);
    const structure = await viewDigest(view.links, packages);
    if (structure.unresolved > 0) {
      fail(
        `${structure.unresolved} view link(s) do not resolve to a certified ` +
          `package; the view no longer represents the installation`,
      );
    }
    const identity = {
      schema: 2,
      role: "toolchain",
      owner: "mise",
      deno,
      platform: `${Deno.build.os}-${Deno.build.arch}`,
      // 1. The certified identity: exactly four members, exact versions.
      tuple,
      // Additional mise-managed build prerequisites, never tuple members.
      prerequisites: {
        typescript: pins["npm:typescript"] ?? null,
        cmake: pins.cmake ?? null,
        ninja: pins.ninja ?? null,
      },
      // 2. Declared packages, as `.mise.toml` pins them.
      spec: await fileDigest(join(appRoot, ".mise.toml")),
      declared,
      // 3. Resolved packages, as discovered in the installed closures.
      resolved: packages
        .map((entry) => ({ name: entry.name, version: entry.version }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
      // 4. Content-based implementation identity of those packages.
      implementation: implementation.digest,
      // 5. Platform bindings, by identity rather than by absolute path.
      bindings: bindings.map((binding) => ({
        owner: binding.owner,
        package: binding.package,
        version: binding.version,
        file: binding.addon.slice(binding.addon.lastIndexOf("/") + 1),
      })),
      // 6. View evidence: the link structure that carries the resolution, and
      //    the digest a consumer recomputes to prove the view still matches.
      view: { root: TOOLCHAIN_VIEW, links: structure.links },
      resolution: structure.digest,
      metadata: {
        packages: implementation.packages,
        files: implementation.files,
        bytes: implementation.bytes,
      },
    };
    Deno.writeTextFileSync(
      join(staging, TOOLCHAIN_RECORD),
      `${JSON.stringify(identity, null, 2)}\n`,
    );

    // 6. Swap: one view, no history, inside the generator subroot.
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

    io.log(`toolchain: installed ${target} (mise-owned view)`);
    io.log(
      `toolchain: tuple deno=${tuple.deno} vite=${tuple.vite} ` +
        `wrangler=${tuple.wrangler} emscripten=${tuple.emscripten}`,
    );
    io.log(
      `toolchain: resolved ${packages.length} packages, ` +
        `${implementation.files} files, from mise`,
    );
    for (const binding of identity.bindings) {
      io.log(
        `toolchain: binding ${binding.owner} -> ${binding.package}@${binding.version}`,
      );
    }
    io.log(`toolchain: implementation=${implementation.digest}`);
    io.log(`toolchain: view=${structure.digest} (${structure.links} links)`);
    return 0;
  } catch (error) {
    io.error(`toolchain: provisioning failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
