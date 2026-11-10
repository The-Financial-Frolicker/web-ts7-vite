/**
 * Resolve the mise-owned toolchain for Deno-hosted execution.
 *
 * mise installs and owns every toolchain package. Deno hosts the tools through
 * their programmatic APIs, and Deno's Node-API loader requires a `node_modules`
 * topology it can walk. This module supplies that topology as a *view*: a
 * directory of symlinks whose targets are the mise-owned package directories.
 *
 * Ownership: mise. Resolution: the view. Nothing is copied, nothing is
 * installed, and the view is never part of any identity record.
 *
 * Everything here is discovered, not assumed:
 *
 *   * the mise data directory follows mise's documented resolution
 *     (`MISE_DATA_DIR`, then `XDG_DATA_HOME`, then `~/.local/share`);
 *   * each tool's installation comes from `<data>/installs/<tool>/<version>`
 *     using the exact version in `.mise.toml`;
 *   * a package's dependencies are its siblings in the store the backend
 *     created, walked to a bounded depth, so no package name is guessed;
 *   * native bindings are found by listing the binding package that matches
 *     this platform and taking the `.node` file that is actually there.
 */

import { mkdirSync, readFileSync, statSync } from "../fs.mjs";
import path from "../path.mjs";

export class ToolchainViewError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolchainViewError";
  }
}

function fail(message) {
  throw new ToolchainViewError(message);
}

function isDirectory(value) {
  try {
    return statSync(value).isDirectory;
  } catch {
    return false;
  }
}

/** mise's data directory, following mise's own resolution order. */
export function miseDataDirectory(env = Deno.env) {
  const explicit = env.get("MISE_DATA_DIR");
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const xdg = env.get("XDG_DATA_HOME");
  if (xdg !== undefined && xdg.length > 0) return path.join(xdg, "mise");

  const home = env.get("HOME");
  if (home === undefined || home.length === 0) {
    fail("neither MISE_DATA_DIR, XDG_DATA_HOME nor HOME is set");
  }
  return path.join(home, ".local", "share", "mise");
}

/** The mise installation directory of one npm tool at an exact version. */
export function miseNpmInstallation(name, version, env = Deno.env) {
  // mise names an npm tool's installation directory by dropping a leading `@`
  // and joining the scope with `-`: `@cloudflare/vite-plugin` is installed as
  // `npm-cloudflare-vite-plugin`. Established from the actual installation, not
  // from the package name.
  const encoded = name.replace(/^@/, "").replaceAll("/", "-");
  const directory = path.join(
    miseDataDirectory(env),
    "installs",
    `npm-${encoded}`,
    version,
  );

  if (!isDirectory(directory)) {
    fail(
      `mise has not installed npm:${name}@${version} (looked in ${directory}). ` +
        `Run \`mise install\` from the generator root.`,
    );
  }

  return directory;
}

/**
 * The package directory and its dependencies, as the backend laid them out.
 *
 * A package's real directory sits inside a store entry whose sibling
 * `node_modules` holds that package's dependencies. Walking those siblings is
 * how the closure is discovered without knowing any package name in advance.
 */
export function packageClosure(
  installedPackageDirectory,
  { depth = 3, limit = 512 } = {},
) {
  const seen = new Map();
  const conflicts = [];
  const truncated = [];

  const visit = (directory, remaining) => {
    let real;
    try {
      real = Deno.realPathSync(directory);
    } catch {
      return;
    }

    let name;
    let version;
    try {
      const parsed = JSON.parse(
        readFileSync(path.join(real, "package.json"), "utf8"),
      );
      name = parsed.name;
      version = parsed.version;
    } catch {
      return;
    }
    if (typeof name !== "string" || name.length === 0) return;

    const previous = seen.get(name);
    if (previous !== undefined) {
      if (previous.version !== version) {
        conflicts.push({ name, versions: [previous.version, version] });
      }
      return;
    }

    seen.set(name, { name, version, directory: real });
    if (seen.size > limit) {
      fail(
        `the package closure under ${installedPackageDirectory} is too large`,
      );
    }
    if (remaining === 0) {
      // A bound must be visible, never a silent omission: report it so the
      // caller can fail instead of working with a partial closure.
      truncated.push(name);
      return;
    }

    let siblings = [];
    try {
      siblings = Deno.readDirSync(path.dirname(real));
    } catch {
      return;
    }

    for (const entry of siblings) {
      // Deno names this predicate `isSymlink`; a symlink is a legitimate
      // dependency entry, and the backend lays most of them out that way.
      if (!entry.isDirectory && !entry.isSymlink) continue;
      const sibling = path.join(path.dirname(real), entry.name);
      if (sibling === real) continue;

      if (entry.name.startsWith("@")) {
        // A scope directory holds packages one level deeper.
        let scoped = [];
        try {
          scoped = Deno.readDirSync(sibling);
        } catch {
          continue;
        }
        for (const inner of scoped) {
          visit(path.join(sibling, inner.name), remaining - 1);
        }
        continue;
      }

      visit(sibling, remaining - 1);
    }
  };

  visit(installedPackageDirectory, depth);

  return { packages: [...seen.values()], conflicts, truncated };
}

/**
 * Platform tags used by npm's per-platform optional packages.
 *
 * Deno and npm name the same platform differently (`x86_64`/`x64`,
 * `windows`/`win32`), so the mapping is explicit rather than incidental.
 */
export function platformTags() {
  const os =
    { linux: "linux", darwin: "darwin", windows: "win32" }[Deno.build.os];
  const arch = { x86_64: "x64", aarch64: "arm64" }[Deno.build.arch];
  if (os === undefined || arch === undefined) {
    fail(`no npm platform tags for ${Deno.build.os}/${Deno.build.arch}`);
  }
  const libc = os === "linux" && isMusl() ? "musl" : "gnu";
  return { os, arch, libc };
}

function isMusl() {
  for (const marker of ["/etc/alpine-release", "/lib/ld-musl-x86_64.so.1"]) {
    if (isDirectory(marker)) continue;
    try {
      statSync(marker);
      return true;
    } catch {
      // Not this marker.
    }
  }
  return false;
}

/**
 * The native binding a package needs on this platform.
 *
 * The binding package is chosen from the *owner's own manifest*: napi-rs
 * packages declare their per-platform packages as dependencies, so the name is
 * read rather than constructed. Rolldown's declaration is scoped
 * (`@rolldown/binding-<platform>`) and LightningCSS's is not
 * (`lightningcss-<platform>`); a name rule would have to special-case one of
 * them, and a manifest rule does not.
 *
 * The `.node` file inside the chosen package is found by listing it, so no file
 * name, version or store layout is assumed.
 */
export function nativeBinding(packages, owner) {
  const ownerPackage = packages.find((entry) => entry.name === owner);
  if (ownerPackage === undefined) {
    fail(`${owner} is not part of the installed toolchain closure`);
  }

  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(path.join(ownerPackage.directory, "package.json"), "utf8"),
    );
  } catch (error) {
    fail(`cannot read ${owner}'s manifest: ${error.message}`);
  }

  const declared = {
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.dependencies ?? {}),
  };
  const { os, arch, libc } = platformTags();
  const tag = `${os}-${arch}`;

  const candidates = Object.keys(declared).filter(
    (name) =>
      name.includes(tag) && packages.some((entry) => entry.name === name),
  );

  const preferred = candidates.find((name) => name.endsWith(`-${libc}`)) ??
    candidates.find((name) => name.endsWith(tag)) ??
    candidates[0];

  if (preferred === undefined) {
    fail(
      `${owner} declares no ${tag} binding that is installed; the toolchain ` +
        `closure is incomplete for this platform`,
    );
  }

  const bindingPackage = packages.find((entry) => entry.name === preferred);
  let entries = [];
  try {
    entries = Deno.readDirSync(bindingPackage.directory);
  } catch (error) {
    fail(`cannot read ${bindingPackage.directory}: ${error.message}`);
  }

  const addons = [];
  for (const entry of entries) {
    if (entry.name.endsWith(".node")) {
      addons.push(path.join(bindingPackage.directory, entry.name));
    }
  }
  if (addons.length === 0) {
    fail(`${bindingPackage.directory} contains no .node addon`);
  }

  return {
    owner,
    package: bindingPackage.name,
    version: bindingPackage.version,
    addon: Deno.realPathSync(addons[0]),
  };
}

/**
 * Build the resolution view: one symlink per package, every target in mise.
 *
 * Deterministic for a given closure. Existing links are only rewritten when
 * their target changed, and links that no longer belong are removed, so the view
 * cannot accumulate stale packages.
 */
export function createResolutionView(viewRoot, packages) {
  const nodeModules = path.join(viewRoot, "node_modules");
  mkdirSync(nodeModules, { recursive: true });

  const wanted = new Map(
    packages.map((entry) => [
      path.join(nodeModules, ...entry.name.split("/")),
      entry.directory,
    ]),
  );

  const existing = [];
  const collect = (directory) => {
    let entries = [];
    try {
      entries = Deno.readDirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isSymlink) existing.push(child);
      else if (entry.isDirectory) collect(child);
    }
  };
  collect(nodeModules);

  for (const stale of existing) {
    if (!wanted.has(stale)) Deno.removeSync(stale, { recursive: true });
  }

  const links = [];
  for (const [destination, target] of [...wanted.entries()].sort()) {
    mkdirSync(path.dirname(destination), { recursive: true });
    let present = false;
    try {
      present = Deno.readLinkSync(destination) === target;
    } catch {
      present = false;
    }
    if (!present) {
      try {
        Deno.removeSync(destination, { recursive: true });
      } catch {
        // Nothing to replace.
      }
      Deno.symlinkSync(target, destination);
    }
    links.push({
      path: destination,
      relative: destination.slice(nodeModules.length + 1),
      target,
    });
  }

  return { nodeModules, links };
}

/**
 * Everything a Deno-hosted launcher needs for one mise-owned npm tool.
 *
 * Returns the view, the package entry points and the native bindings, all
 * discovered from the mise installation. `deno` requirements are reported so a
 * launcher can assert `--node-modules-dir=manual` and the FFI grants.
 *
 * `depth` bounds the closure walk. It is explicit because the bound depends on
 * the tool, not on a house style: Vite's closure completes at the default, while
 * Wrangler's (`wrangler -> sharp -> @img/sharp-libvips-*`) needs more, and a
 * bound that is too small must fail rather than return a partial closure.
 */
export function resolveMiseTool(
  {
    name,
    version,
    viewRoot,
    bindings = [],
    depth = 3,
    limit = 512,
    env = Deno.env,
  },
) {
  const installation = miseNpmInstallation(name, version, env);
  const entry = path.join(installation, "node_modules", ...name.split("/"));
  if (!isDirectory(entry) && !Deno.statSync(entry)) {
    fail(`npm:${name}@${version} has no ${name} package in ${installation}`);
  }

  const closure = packageClosure(entry, { depth, limit });
  if (closure.truncated.length > 0) {
    fail(
      `the closure of npm:${name}@${version} hit the traversal bound at ` +
        `${closure.truncated.slice(0, 3).join(", ")}; raise the depth rather ` +
        `than accepting a partial closure`,
    );
  }
  if (closure.conflicts.length > 0) {
    fail(
      `npm:${name}@${version} resolves conflicting versions of ` +
        closure.conflicts
          .map((c) => `${c.name} (${c.versions.join(", ")})`)
          .join(", ") +
        `; the closure is ambiguous`,
    );
  }
  const view = createResolutionView(viewRoot, closure.packages);
  const natives = bindings.map((prefix) =>
    nativeBinding(closure.packages, prefix)
  );

  return {
    name,
    version,
    installation,
    entry: Deno.realPathSync(entry),
    view,
    packages: closure.packages,
    conflicts: closure.conflicts,
    bindings: natives,
  };
}

/** sha256 of a byte string, lowercase hex. */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** sha256 of a UTF-8 string, lowercase hex. */
async function sha256Text(text) {
  return await sha256Hex(new TextEncoder().encode(text));
}

/**
 * The closure of one declared npm tool: its package directory plus the siblings
 * the backend laid out, walked to an explicit depth and failing closed.
 */
export function toolClosure(name, version, env = Deno.env, depth = 3) {
  const installation = miseNpmInstallation(name, version, env);
  const entry = path.join(installation, "node_modules", ...name.split("/"));
  if (!isDirectory(entry)) {
    fail(`npm:${name}@${version} has no ${name} package in ${installation}`);
  }

  const closure = packageClosure(entry, { depth });
  if (closure.truncated.length > 0) {
    fail(
      `the closure of npm:${name}@${version} hit the traversal bound at ` +
        `${closure.truncated.slice(0, 3).join(", ")}; the toolchain ` +
        `installation is incomplete for this depth`,
    );
  }
  if (closure.conflicts.length > 0) {
    fail(
      `npm:${name}@${version} resolves conflicting versions of ` +
        closure.conflicts
          .map((c) => `${c.name} (${c.versions.join(", ")})`)
          .join(", ") +
        `; the closure is ambiguous`,
    );
  }
  return closure.packages;
}

/**
 * The union of several tool closures, keyed by package name.
 *
 * A package that two tools both pull in must be the *same* version, or the view
 * could not represent both. That is refused rather than resolved: picking one
 * would silently change one tool's dependency.
 */
export function unionClosure(closures) {
  const merged = new Map();
  const conflicts = [];

  for (const packages of closures) {
    for (const entry of packages) {
      const previous = merged.get(entry.name);
      if (previous === undefined) {
        merged.set(entry.name, entry);
        continue;
      }
      if (previous.version !== entry.version) {
        conflicts.push({
          name: entry.name,
          versions: [previous.version, entry.version],
        });
      }
    }
  }

  if (conflicts.length > 0) {
    fail(
      `the toolchain closures disagree on ` +
        conflicts.map((c) => `${c.name} (${c.versions.join(", ")})`).join(
          ", ",
        ) +
        `; the resolution view cannot represent both`,
    );
  }

  return [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * A portable, content-based digest of the installed package implementations.
 *
 * What is hashed: for every package, its real directory walked in sorted order.
 *
 *   p <name>@<version>\\n            package header
 *   d <relative path>\\n             directory
 *   f <relative path> <x|-> <sha256 of contents>\\n   regular file
 *   l <relative path> -> <target>\\n symlink, target normalised (below)
 *
 * What is deliberately excluded: absolute installation paths (the home
 * directory, the mise data directory, the store layout), timestamps, ownership,
 * and every file mode bit except the executable bit. Those differ between two
 * machines holding the same packages, and none of them changes what the tool
 * does.
 *
 * Symlink targets are normalised so that an equivalent installation in another
 * location hashes identically: a target that stays inside its own package is
 * recorded as `in:<path relative to the package root>`; a target that resolves
 * into another *resolved* package is recorded as `<name>@<version>/<relative
 * path>`. The backend's store layout is never hashed, only the identity of what
 * a link points at.
 *
 * A target outside the certified closure — or a broken link — is **refused**, not
 * collapsed to a constant: no portable value can describe a target whose content
 * is not digested, and a constant would let two materially different
 * installations produce one identity. The policy is scoped by measurement: the
 * certified closure of this toolchain (46 packages) contains no symlinks at all,
 * so the internal and package-target rules are the only ones that can currently
 * apply, and the refusal is a guard rather than a behaviour in use.
 *
 * The result changes if any package byte, name, version, symlink shape or
 * package set changes, and it does not change when the same packages are
 * installed under a different root.
 */
export async function implementationDigest(packages) {
  const byDirectory = new Map(
    packages.map((entry) => [Deno.realPathSync(entry.directory), entry]),
  );

  const normaliseTarget = (packageEntry, file) => {
    let resolved;
    try {
      resolved = Deno.realPathSync(file);
    } catch (error) {
      // A link whose target is missing cannot be certified: what it pointed at
      // is not part of the digests, so any value would be a guess.
      fail(
        `the package ${packageEntry.name}@${packageEntry.version} contains a ` +
          `broken symlink ${file} (${error.message}); the closure cannot be ` +
          `certified by content`,
      );
    }
    const own = Deno.realPathSync(packageEntry.directory);
    if (resolved === own) return "in:.";
    if (resolved.startsWith(`${own}${path.sep}`)) {
      return `in:${resolved.slice(own.length + 1)}`;
    }
    const owner = byDirectory.get(resolved);
    if (owner !== undefined) return `${owner.name}@${owner.version}`;
    for (const [directory, entry] of byDirectory) {
      if (resolved.startsWith(`${directory}${path.sep}`)) {
        return `${entry.name}@${entry.version}/${
          resolved.slice(directory.length + 1)
        }`;
      }
    }
    // A target outside the certified closure is not represented by any digest
    // here, so no portable value can describe it. Treating every such target as
    // one constant would let two materially different installations collapse to
    // the same identity, which is exactly what an identity must not do. This
    // closure contains no such link (measured: zero symlinks of any kind), so
    // failing closed costs nothing today and refuses to certify what it cannot
    // see.
    fail(
      `the package ${packageEntry.name}@${packageEntry.version} links ${file} ` +
        `outside the certified closure (${resolved}); the digest cannot ` +
        `represent that target portably, so the installation is refused`,
    );
  };

  const lines = [];
  let files = 0;
  let bytes = 0;

  const walk = async (packageEntry, directory, prefix) => {
    const entries = [];
    for (const entry of Deno.readDirSync(directory)) entries.push(entry);
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));

    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);

      if (entry.isSymlink) {
        lines.push(
          `l ${relative} -> ${normaliseTarget(packageEntry, absolute)}`,
        );
        continue;
      }
      if (entry.isDirectory) {
        lines.push(`d ${relative}`);
        await walk(packageEntry, absolute, relative);
        continue;
      }
      if (!entry.isFile) continue;

      const contents = Deno.readFileSync(absolute);
      const executable = (Deno.statSync(absolute).mode ?? 0) & 0o111;
      files += 1;
      bytes += contents.length;
      lines.push(
        `f ${relative} ${executable === 0 ? "-" : "x"} ${await sha256Hex(
          contents,
        )}`,
      );
    }
  };

  for (
    const entry of [...packages].sort((a, b) => (a.name < b.name ? -1 : 1))
  ) {
    lines.push(`p ${entry.name}@${entry.version}`);
    await walk(entry, Deno.realPathSync(entry.directory), "");
  }

  return {
    digest: await sha256Text(`${lines.join("\n")}\n`),
    packages: packages.length,
    files,
    bytes,
  };
}

/**
 * A digest of the resolution view's *structure*: which link points at which
 * package identity. Absolute targets are mapped back to `name@version`, so the
 * digest is portable and still detects a view that no longer represents the
 * certified installation (a missing, extra or retargeted link).
 */
export async function viewDigest(links, packages) {
  const byDirectory = new Map(
    packages.map((entry) => [Deno.realPathSync(entry.directory), entry]),
  );

  const lines = links.map((link) => {
    const identity = byDirectory.get(Deno.realPathSync(link.path));
    const target = identity === undefined
      ? "unresolved"
      : `${identity.name}@${identity.version}`;
    return `${link.relative} -> ${target}`;
  }).sort();

  return {
    digest: await sha256Text(`${lines.join("\n")}\n`),
    links: links.length,
    unresolved: lines.filter((line) => line.endsWith("-> unresolved")).length,
  };
}

/**
 * The packages a materialised view resolves, read from the links themselves.
 *
 * Verification cannot trust the record's inventory: it must observe what the
 * view actually points at and digest *those* contents. A link that resolves
 * nowhere, or to something with no package manifest, fails closed.
 */
export function packagesFromView(nodeModules) {
  const packages = [];

  const visit = (directory) => {
    const entries = [];
    for (const entry of Deno.readDirSync(directory)) entries.push(entry);
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymlink) {
        let real;
        try {
          real = Deno.realPathSync(absolute);
        } catch (error) {
          fail(`the view link ${absolute} resolves nowhere (${error.message})`);
        }
        let manifest;
        try {
          manifest = JSON.parse(
            readFileSync(path.join(real, "package.json"), "utf8"),
          );
        } catch (error) {
          fail(`${absolute} does not resolve to a package (${error.message})`);
        }
        if (
          typeof manifest.name !== "string" ||
          typeof manifest.version !== "string"
        ) {
          fail(`${absolute} resolves to a package with no name or version`);
        }
        packages.push({
          name: manifest.name,
          version: manifest.version,
          directory: real,
        });
        continue;
      }
      if (entry.isDirectory) visit(absolute);
    }
  };

  visit(nodeModules);
  return packages.sort((a, b) => (a.name < b.name ? -1 : 1));
}
