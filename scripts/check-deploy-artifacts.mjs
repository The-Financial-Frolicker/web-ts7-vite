/**
 * Deployment compatibility check for the generated deployment artefacts.
 *
 * `vite build` writes a Worker bundle, a client asset tree and a resolved
 * Wrangler configuration to `dist/`. This script verifies that the resolved
 * configuration, the files it references and the project identity agree before
 * `wrangler deploy` is allowed to run:
 *
 *   - the generated Worker name matches package.json;
 *   - `no_bundle` is set, so the tested bundle is uploaded unchanged;
 *   - the generated config, `main` and the assets directory resolve inside
 *     `dist/` both lexically and after resolving symbolic links, and exist;
 *   - the client contains its entry point and the published WASM pair;
 *   - asset routing (binding, SPA fallback, run_worker_first) survived the build;
 *   - a source map exists when `upload_source_maps` is enabled;
 *   - the generated configuration does not opt the Worker into Node.js
 *     compatibility, and the executable artefacts contain no Node.js runtime
 *     dependency (see "Node.js dependency boundary" in README.md);
 *   - the published WASM glue is browser-only: no `node:` specifier, no
 *     `require()` loading path, and the `ENVIRONMENT_IS_WEB` marker present.
 *
 * Symbolic links are resolved for every referenced path, so an artefact whose
 * real path leaves the real `dist/` tree is rejected. These are point-in-time
 * checks: they do not protect against a path being replaced between this check
 * and the later upload.
 *
 * The generated file is strict JSON emitted by the Vite plugin, not the
 * `wrangler.jsonc` source. It is parsed with JSON.parse, so comment-like text
 * inside strings is preserved and JSONC comments or trailing commas fail
 * closed instead of being silently reinterpreted.
 *
 * This is deliberately independent of `wrangler deploy --dry-run`: the dry run
 * proves the configuration is accepted, while this check proves it describes
 * the artefacts that were built and tested.
 *
 * Exit codes: 0 all checks pass, 1 a check failed.
 */

import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "./lib/fs.mjs";
import path from "./lib/path.mjs";

export const DEPLOY_CONFIG = path.join("dist", "worker", "wrangler.json");

export class DeployArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeployArtifactError";
  }
}

function fail(message) {
  throw new DeployArtifactError(message);
}

function readJson(file, label) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`Cannot read ${label} (${file}): ${error.message}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`Cannot parse ${label} (${file}): ${error.message}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }

  return value;
}

/** Resolve a path, failing with a clear message when it cannot be read. */
function realPath(file, label) {
  try {
    return realpathSync(file);
  } catch (error) {
    fail(
      `${label} is missing or cannot be resolved: ${file} (${error.message})`,
    );
  }
}

/**
 * Resolve symbolic links for `file` and require the real path to stay inside
 * the real `dist` tree. Returns the real path.
 */
function requireRealInside(realDistRoot, file, label) {
  const real = realPath(file, label);
  const inside = path.relative(realDistRoot, real);

  if (
    inside === "" ||
    inside === ".." ||
    inside.startsWith(`..${path.sep}`) ||
    path.isAbsolute(inside)
  ) {
    fail(
      `${label} resolves outside the real dist/ tree through a symbolic link: ` +
        `${file} -> ${real}`,
    );
  }

  return real;
}

/** Require a real directory inside dist, returning its resolved path. */
function realDirectory(directory, label) {
  const real = realPath(directory, label);

  let stats;
  try {
    stats = statSync(real);
  } catch (error) {
    fail(
      `${label} is missing or cannot be resolved: ${directory} (${error.message})`,
    );
  }

  if (!stats.isDirectory()) {
    fail(`${label} is not a directory: ${directory}`);
  }

  return real;
}

/**
 * Require a non-empty regular file whose resolved path stays inside dist.
 * Returns the resolved path, so companion artefacts (such as a source map)
 * are looked up next to the real file rather than next to a symlink.
 */
function requireFile(file, label, realDistRoot) {
  let stats;
  try {
    stats = statSync(file);
  } catch (error) {
    fail(
      `${label} is missing or cannot be resolved: ${file} (${error.message})`,
    );
  }

  if (!stats.isFile()) {
    fail(`${label} is not a regular file: ${file}`);
  }

  if (stats.size === 0) {
    fail(`${label} is empty: ${file}`);
  }

  return requireRealInside(realDistRoot, file, label);
}

/** Require a directory whose resolved path stays inside dist. */
function requireDirectory(directory, label, realDistRoot) {
  let stats;
  try {
    stats = statSync(directory);
  } catch (error) {
    fail(
      `${label} is missing or cannot be resolved: ${directory} (${error.message})`,
    );
  }

  if (!stats.isDirectory()) {
    fail(`${label} is not a directory: ${directory}`);
  }

  return requireRealInside(realDistRoot, directory, label);
}

/**
 * Resolve a path declared by the generated configuration and refuse anything
 * that lexically escapes the built `dist/` tree. Callers must additionally
 * run the result through requireRealInside() so a symlink cannot redirect it.
 */
function resolveWithin(distRoot, baseDir, relative, label) {
  const resolved = path.resolve(baseDir, relative);
  const inside = path.relative(distRoot, resolved);

  if (
    inside === "" ||
    inside === ".." ||
    inside.startsWith(`..${path.sep}`) ||
    path.isAbsolute(inside)
  ) {
    fail(
      `${label} (${
        JSON.stringify(relative)
      }) resolves outside dist/: ${resolved}`,
    );
  }

  return resolved;
}

/* ---------------------------------------------------------------------------
 * Node.js dependency boundary
 *
 * The delivered application runs in a browser and on Cloudflare Workers;
 * neither provides Node.js. See "Node.js dependency boundary" in README.md.
 *
 * These checks are textual and therefore conservative in one direction only:
 * they prove that a Node reference *is* present, they cannot prove that no Node
 * dependency exists at run time. Source maps are excluded because they are
 * never executed.
 * ------------------------------------------------------------------------- */

/**
 * Bare `process` access. Together with the global-object member rule below it is
 * the reference class Emscripten's generated glue may partially satisfy: the
 * glue emits read-only environment probes (`process.versions`, and
 * `globalThis.process?.versions`/`?.type`) even in browser-only output. Those two
 * rules are marked `capabilityProbe`, so `checkBundleText` skips them for the
 * glue; `checkWasmGlue` then applies them to everything except the exact probe
 * shapes listed in EMSCRIPTEN_PROCESS_PROBES.
 */
const NODE_PROCESS_REFERENCE = Object.freeze({
  label: "the Node process global",
  pattern: /(?<![\w$.])process\s*(?:\.|\[|\?\.)/g,
  capabilityProbe: true,
});

/** `process` reached through a global object rather than a bare identifier. */
const NODE_PROCESS_MEMBER_REFERENCE = Object.freeze({
  label: "the Node process global reached through a global object",
  pattern: /(?<![\w$])(?:globalThis|window|self)\s*(?:\?\.|\.)\s*process\b/g,
  capabilityProbe: true,
});

/** Patterns that must not appear in an executable client or Worker bundle. */
export const FORBIDDEN_BUNDLE_REFERENCES = Object.freeze([
  {
    label: "a Node built-in module specifier",
    pattern: /(?<![\w$.])node:[a-z][a-z0-9_/.-]*/g,
  },
  {
    label: "a cloudflare:node capability reference",
    pattern: /(?<![\w$])cloudflare:node\b/g,
  },
  {
    label: "a CommonJS require() call",
    pattern: /(?<![\w$.])require\s*\(/g,
  },
  NODE_PROCESS_REFERENCE,
  NODE_PROCESS_MEMBER_REFERENCE,
  {
    label: "the Node Buffer global",
    pattern: /(?<![\w$.])Buffer\s*(?:\.|\[|\()/g,
  },
  {
    label: "a CommonJS module.exports reference",
    pattern: /(?<![\w$.])module\s*\.\s*exports\b/g,
  },
  {
    label: "a Node file-path global",
    pattern: /(?<![\w$.])__(?:dirname|filename)\b/g,
  },
  {
    label: "the Node setImmediate global",
    pattern: /(?<![\w$.])setImmediate\s*\(/g,
  },
]);

/**
 * Browser-only glue: the marker Emscripten emits for `-sENVIRONMENT=web`.
 *
 * The same output also retains dead `ENVIRONMENT_IS_NODE` text in its
 * environment assertion, so its *absence* is not a signal and is not asserted.
 */
export const BROWSER_ENVIRONMENT_MARKER = "ENVIRONMENT_IS_WEB";

/**
 * The only `process` expressions accepted in the published glue, written as
 * Emscripten 6.0.13 emits them. Each is a read-only environment probe: it reads a
 * version string or an Electron-style `type`, loads nothing and grants no
 * capability.
 *
 *   - `process.versions` / `process?.versions`           (bare version probe)
 *   - `globalThis.process?.versions` / `globalThis.process?.type`
 *
 * The list is deliberately exact and short. Anything else — `process.env`,
 * `globalThis.process.env`, `window.process.env`, `self.process.env`, any other
 * member — is a Node capability and fails `checkWasmGlue`.
 */
const EMSCRIPTEN_PROCESS_PROBES = Object.freeze([
  /(?<![\w$])globalThis\s*(?:\?\.|\.)\s*process\s*(?:\?\.|\.)\s*(?:versions|type)\b/g,
  /(?<![\w$.])process\s*(?:\?\.|\.)\s*versions\b/g,
]);

/**
 * Remove the accepted probe shapes, leaving every other `process` use intact.
 *
 * Each match is replaced by spaces of the same length rather than deleted, so
 * offsets reported for a remaining misuse still refer to the original source.
 */
function stripProcessProbes(source) {
  return EMSCRIPTEN_PROCESS_PROBES.reduce(
    (text, pattern) =>
      text.replace(pattern, (match) => " ".repeat(match.length)),
    source,
  );
}

/** Count the accepted probe shapes, for reporting. */
function countProcessProbes(source) {
  return EMSCRIPTEN_PROCESS_PROBES.reduce(
    (count, pattern) => count + [...source.matchAll(pattern)].length,
    0,
  );
}

/**
 * Compatibility flags that would opt the Worker into Node.js emulation,
 * including the `nodejs_compat*` variants Cloudflare has shipped. Matching the
 * family, not an exact list, means a new variant cannot slip through.
 */
export const FORBIDDEN_COMPATIBILITY_FLAG = /^(?:nodejs_als|nodejs_compat)/;

/** Return every forbidden reference in a bundle, in source order. */
export function findForbiddenBundleReferences(source, options = {}) {
  const found = [];

  for (const reference of FORBIDDEN_BUNDLE_REFERENCES) {
    if (options.allowCapabilityProbe === true && reference.capabilityProbe) {
      continue;
    }

    for (const match of source.matchAll(reference.pattern)) {
      found.push({
        label: reference.label,
        index: match.index,
        text: match[0],
      });
    }
  }

  return found.sort((left, right) => left.index - right.index);
}

/** Fail when a client or Worker bundle carries a Node.js reference. */
export function checkBundleText(source, label, options = {}) {
  const [first] = findForbiddenBundleReferences(source, options);
  if (first === undefined) return;

  fail(
    `${label} must not depend on Node.js: found ${first.label} ` +
      `${
        JSON.stringify(first.text)
      } at offset ${first.index}. The browser and ` +
      'the Worker runtime do not provide Node; see "Node.js dependency ' +
      'boundary" in README.md.',
  );
}

/**
 * Check the published WASM glue is browser-only.
 *
 * The glue is held to the same rules as every other executable artefact. The one
 * relaxation is exact: the read-only environment probes Emscripten emits
 * (`process.versions`, `globalThis.process?.versions`/`?.type`, listed in
 * EMSCRIPTEN_PROCESS_PROBES) are stripped, and the two `process` rules are then
 * applied to what remains. That rejects `process.env` whether it is reached
 * directly or through `globalThis`, `window` or `self`, while keeping the probes
 * the generated glue legitimately needs.
 *
 * The glue must also declare `ENVIRONMENT_IS_WEB`, which is what
 * `-sENVIRONMENT=web` produces. Its dead `ENVIRONMENT_IS_NODE` assertion text is
 * deliberately not asserted on.
 *
 * Returns `{ environment, processProbes }` so the caller can report what it
 * accepted.
 */
export function checkWasmGlue(source, label) {
  checkBundleText(source, label, { allowCapabilityProbe: true });

  const withoutProbe = stripProcessProbes(source);
  const [misuse] = [
    ...withoutProbe.matchAll(NODE_PROCESS_REFERENCE.pattern),
    ...withoutProbe.matchAll(NODE_PROCESS_MEMBER_REFERENCE.pattern),
  ].sort((left, right) => left.index - right.index);

  if (misuse !== undefined) {
    fail(
      `${label} must not depend on Node.js: found a \`process\` capability ` +
        `${JSON.stringify(misuse[0])} at offset ${misuse.index}. Only ` +
        "Emscripten's read-only probes are accepted in the glue " +
        "(process.versions, globalThis.process?.versions/?.type); " +
        "`process.env` and every other member are not.",
    );
  }

  if (!source.includes(BROWSER_ENVIRONMENT_MARKER)) {
    fail(
      `${label} is not browser-only: it does not declare ` +
        `${BROWSER_ENVIRONMENT_MARKER}. Build the module with ` +
        "`-sENVIRONMENT=web`; see wasm/CMakeLists.txt.",
    );
  }

  return {
    environment: BROWSER_ENVIRONMENT_MARKER,
    processProbes: countProcessProbes(source),
  };
}

/**
 * Fail when the generated configuration enables Node.js compatibility, which
 * would make Node globals available to the Worker and so hide a real dependency.
 */
export function checkCompatibilityFlags(config) {
  const flags = config.compatibility_flags;
  if (flags === undefined) return [];

  if (!Array.isArray(flags)) {
    fail('generated "compatibility_flags" must be an array');
  }

  for (const flag of flags) {
    if (typeof flag !== "string") {
      fail('generated "compatibility_flags" entries must be strings');
    }

    if (FORBIDDEN_COMPATIBILITY_FLAG.test(flag)) {
      fail(
        `generated "compatibility_flags" contains ${JSON.stringify(flag)}, ` +
          "which opts the Worker into Node.js compatibility. The deployed " +
          'Worker must not depend on Node; see "Node.js dependency ' +
          'boundary" in README.md.',
      );
    }
  }

  return [...flags];
}

/**
 * Executable client bundles: `.js` files below the assets directory, excluding
 * the `wasm/` subtree (checked separately as browser-only glue) and source
 * maps, which are never executed.
 */
function listClientBundles(directory) {
  const bundles = [];

  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "wasm") continue;
        walk(absolute);
        continue;
      }

      if (entry.isFile() && /\.m?js$/.test(entry.name)) bundles.push(absolute);
    }
  };

  walk(directory);
  return bundles.sort();
}

/** Read a text artefact, failing with the file name when it cannot be read. */
function readTextFile(file, label) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    fail(`Cannot read ${label} (${file}): ${error.message}`);
  }
}

/**
 * Check the deployment artefacts under `root` and return a summary. Throws
 * DeployArtifactError with an actionable message on the first failure.
 */
export function checkDeployArtifacts(root = Deno.cwd()) {
  const projectRoot = path.resolve(root);
  const distRoot = path.join(projectRoot, "dist");
  const configFile = path.join(projectRoot, DEPLOY_CONFIG);

  const packageJson = readJson(
    path.join(projectRoot, "package.json"),
    "package.json",
  );
  const packageName = requireString(packageJson.name, 'package.json "name"');

  const realDistRoot = realDirectory(distRoot, "generated output directory");
  requireFile(
    configFile,
    "generated Wrangler configuration",
    realDistRoot,
  );

  const config = readJson(configFile, "generated Wrangler configuration");
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    fail("the generated Wrangler configuration must be a JSON object");
  }

  const workerName = requireString(config.name, 'generated Worker "name"');
  if (workerName !== packageName) {
    fail(
      `generated Worker name ${JSON.stringify(workerName)} does not match ` +
        `package.json name ${JSON.stringify(packageName)}. ` +
        "Re-run the project initialiser or rebuild.",
    );
  }

  const compatibilityDate = requireString(
    config.compatibility_date,
    'generated "compatibility_date"',
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) {
    fail(
      `generated "compatibility_date" is not a YYYY-MM-DD date: ${
        JSON.stringify(compatibilityDate)
      }`,
    );
  }

  const compatibilityFlags = checkCompatibilityFlags(config);

  if (config.no_bundle !== true) {
    fail(
      'the generated Worker configuration must set "no_bundle": true so that ' +
        "the tested Worker bundle is uploaded unchanged",
    );
  }

  const configDir = path.dirname(configFile);
  const main = requireString(config.main, 'generated Worker "main"');
  const workerEntry = resolveWithin(
    distRoot,
    configDir,
    main,
    'generated Worker "main"',
  );
  const realWorkerEntry = requireFile(
    workerEntry,
    "Worker bundle",
    realDistRoot,
  );
  checkBundleText(
    readTextFile(realWorkerEntry, "Worker bundle"),
    "Worker bundle",
  );

  if (config.upload_source_maps === true) {
    requireFile(
      `${realWorkerEntry}.map`,
      "Worker source map",
      realDistRoot,
    );
  }

  const assets = config.assets;
  if (assets === null || typeof assets !== "object" || Array.isArray(assets)) {
    fail('the generated configuration has no "assets" object');
  }

  const binding = requireString(assets.binding, 'assets "binding"');
  const directory = requireString(assets.directory, 'assets "directory"');
  const assetsDirectory = resolveWithin(
    distRoot,
    configDir,
    directory,
    'assets "directory"',
  );
  const realAssetsDirectory = requireDirectory(
    assetsDirectory,
    "client assets directory",
    realDistRoot,
  );
  requireFile(
    path.join(realAssetsDirectory, "index.html"),
    "client index.html",
    realDistRoot,
  );
  const realWasmGlue = requireFile(
    path.join(realAssetsDirectory, "wasm", "wasm_math.js"),
    "published WASM glue",
    realDistRoot,
  );
  requireFile(
    path.join(realAssetsDirectory, "wasm", "wasm_math.wasm"),
    "published WASM binary",
    realDistRoot,
  );

  // Client bundles and the WASM glue are held to the same strict rules.
  const clientBundles = listClientBundles(realAssetsDirectory);
  for (const bundle of clientBundles) {
    checkBundleText(
      readTextFile(bundle, "client bundle"),
      `client bundle ${path.relative(realAssetsDirectory, bundle)}`,
    );
  }

  const wasmGlueBoundary = checkWasmGlue(
    readTextFile(realWasmGlue, "published WASM glue"),
    "published WASM glue",
  );

  const notFoundHandling = requireString(
    assets.not_found_handling,
    'assets "not_found_handling"',
  );
  const runWorkerFirst = assets.run_worker_first;
  if (runWorkerFirst !== true) {
    if (!Array.isArray(runWorkerFirst) || runWorkerFirst.length === 0) {
      fail(
        'assets "run_worker_first" must be true or a non-empty array of route patterns',
      );
    }

    for (const pattern of runWorkerFirst) {
      requireString(pattern, 'assets "run_worker_first" entry');
    }
  }

  return {
    name: workerName,
    workerEntry,
    assetsDirectory,
    binding,
    notFoundHandling,
    compatibilityFlags,
    nodeBoundary: {
      clientBundles: clientBundles.length,
      wasmGlue: wasmGlueBoundary,
    },
  };
}

/** CLI entry point; returns a process exit code instead of exiting directly. */
export function main(argv = Deno.args, io = console) {
  if (argv.length > 0) {
    io.error(
      "Usage: deno run --allow-read --allow-env scripts/check-deploy-artifacts.mjs\n\n" +
        "Run from the project root after `deno task build`.",
    );
    return 1;
  }

  try {
    const result = checkDeployArtifacts();
    io.log(
      `Deployment artefacts OK: Worker "${result.name}" ` +
        `(${path.relative(Deno.cwd(), result.workerEntry)}), ` +
        `assets ${path.relative(Deno.cwd(), result.assetsDirectory)} ` +
        `(binding ${result.binding}).`,
    );
    io.log(
      "Node boundary OK: Worker and " +
        `${result.nodeBoundary.clientBundles} client bundle(s) are ` +
        "Node-free; the generated configuration enables no Node.js " +
        "compatibility flag; the published WASM glue is browser-only " +
        `(${result.nodeBoundary.wasmGlue.environment}, ` +
        `${result.nodeBoundary.wasmGlue.processProbes} read-only process ` +
        "probe(s), no node: specifiers, no require()).",
    );
    return 0;
  } catch (error) {
    if (error instanceof DeployArtifactError) {
      io.error(`Error: ${error.message}`);
      return 1;
    }

    throw error;
  }
}

if (import.meta.main) {
  Deno.exitCode = main();
}
