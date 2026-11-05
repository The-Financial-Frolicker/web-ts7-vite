/**
 * Toolchain discovery: what do the *installed* tools actually provide?
 *
 * Everything here is read from the packages and binaries that are installed for
 * this run, so an upgrade changes the answers instead of silently invalidating a
 * constant. Nothing in this module decides policy — see `contracts.mjs`.
 */

/** Thrown when a discovery step cannot read the installed tool. */
export class DiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscoveryError";
  }
}

const PLATFORM_NAMES = Object.freeze({
  linux: "linux",
  darwin: "darwin",
  windows: "win32",
  freebsd: "freebsd",
  aix: "aix",
});

/** `<os>-<arch>` as the npm platform packages spell it. */
export function platformSuffix() {
  const os = PLATFORM_NAMES[Deno.build.os] ?? Deno.build.os;
  const arch = Deno.build.arch === "x86_64" ? "x64" : Deno.build.arch;
  return `${os}-${arch}`;
}

/**
 * Locate an installed package by name, optionally at an exact version.
 *
 * Handles both layouts Deno produces: a flat `node_modules/<name>` entry and the
 * content-addressed `node_modules/.deno/<pkg>@<version>/node_modules/<name>`
 * store, without hard-coding a version or a store hash.
 *
 * `options.version` exists because the same package can legitimately be
 * installed more than once (an ecosystem dependency graph may pin different
 * versions in different branches). Callers that know which version the graph
 * selected pass it here; callers that do not still get the "refuse to guess"
 * behaviour below.
 */
export function findPackage(root, name, options = {}) {
  const wanted = options.version;

  try {
    const manifest = readManifest(`${root}/node_modules/${name}/package.json`);
    if (wanted === undefined || manifest.version === wanted) {
      return { dir: `${root}/node_modules/${name}`, manifest };
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const store = `${root}/node_modules/.deno`;
  let entries;
  try {
    entries = [...Deno.readDirSync(store)];
  } catch {
    throw new DiscoveryError(
      `cannot find ${name}: neither node_modules/${name} nor the Deno store ${store} exists. Run: mise exec -- deno install --frozen`,
    );
  }

  const matches = [];
  const seen = new Set();
  for (const entry of entries) {
    const dir = `${store}/${entry.name}/node_modules/${name}`;
    try {
      const manifest = readManifest(`${dir}/package.json`);
      if (wanted !== undefined && manifest.version !== wanted) continue;
      // The same package is often linked into several store entries; collapse
      // those to one real directory before deciding anything.
      const real = Deno.realPathSync(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      matches.push({ dir: real, manifest });
    } catch {
      // Not this package; keep looking.
    }
  }

  if (matches.length === 0) {
    throw new DiscoveryError(
      wanted === undefined
        ? `cannot find ${name} in ${store}. Run: mise exec -- deno install --frozen`
        : `cannot find ${name}@${wanted} in ${store}. Run: mise exec -- deno install --frozen`,
    );
  }
  if (matches.length > 1) {
    throw new DiscoveryError(
      `found ${matches.length} different installed copies of ${name}; refusing to guess. Remove stale store entries first.`,
    );
  }
  return matches[0];
}

function readManifest(path) {
  return JSON.parse(Deno.readTextFileSync(path));
}

/**
 * Discover the installed TypeScript compiler: its version, its standard-library
 * editions and the extra libraries it ships (for example `DOM`).
 *
 * TypeScript 7 keeps `lib.*.d.ts` in the platform package, so both the compiler
 * package and the platform package are inspected rather than assuming one.
 */
export function discoverTypeScript(root) {
  const compiler = findPackage(root, "typescript");
  const libDirs = [`${compiler.dir}/lib`];

  try {
    const platform = findPackage(
      root,
      `@typescript/typescript-${platformSuffix()}`,
    );
    libDirs.unshift(`${platform.dir}/lib`);
  } catch {
    // Older releases keep the libs in the compiler package itself.
  }

  let libDir = null;
  for (const candidate of libDirs) {
    try {
      Deno.statSync(candidate);
      libDir = candidate;
      break;
    } catch {
      // Try the next candidate.
    }
  }
  if (libDir === null) {
    throw new DiscoveryError(
      `cannot find TypeScript's lib directory under ${compiler.dir}. The installed layout may have changed.`,
    );
  }

  const editions = [];
  const libraries = [];
  for (const entry of Deno.readDirSync(libDir)) {
    const match = /^lib\.([a-z0-9]+)\.d\.ts$/.exec(entry.name);
    if (match === null) continue;
    const id = match[1];
    if (/^es(?:[0-9]{4}|6|next)$/.test(id)) editions.push(id);
    else libraries.push(id);
  }

  return {
    version: compiler.manifest.version,
    libDir,
    editions: sortEditions(editions),
    libraries: libraries.sort(),
  };
}

/**
 * Order ES editions from oldest to newest, with `esnext` last.
 *
 * `es6` is an alias for `es2015`, so the two share a rank. The comparator then
 * falls back to the id itself: without that tie-break the recorded order would
 * follow the directory listing, which differs between filesystems and made the
 * committed lock irreproducible on the authoritative runner.
 */
export function sortEditions(editions) {
  const rank = (id) => {
    if (id === "esnext") return Number.MAX_SAFE_INTEGER;
    if (id === "es6") return 2015;
    return Number(id.slice(2));
  };
  // Code-unit comparison: locale-independent, so every machine agrees.
  const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  return [...editions].sort((a, b) => rank(a) - rank(b) || byCodeUnit(a, b));
}

/** The newest edition the installed compiler can declare. */
export function newestEdition(editions) {
  if (editions.length === 0) {
    throw new DiscoveryError(
      "the installed TypeScript ships no ES library editions",
    );
  }
  return sortEditions(editions)[editions.length - 1];
}
