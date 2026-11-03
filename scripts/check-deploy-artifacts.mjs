#!/usr/bin/env node
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
 *   - a source map exists when `upload_source_maps` is enabled.
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

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

/**
 * Check the deployment artefacts under `root` and return a summary. Throws
 * DeployArtifactError with an actionable message on the first failure.
 */
export function checkDeployArtifacts(root = process.cwd()) {
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
  requireFile(
    path.join(realAssetsDirectory, "wasm", "wasm_math.js"),
    "published WASM glue",
    realDistRoot,
  );
  requireFile(
    path.join(realAssetsDirectory, "wasm", "wasm_math.wasm"),
    "published WASM binary",
    realDistRoot,
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
  };
}

/** CLI entry point; returns a process exit code instead of exiting directly. */
export function main(argv = process.argv.slice(2), io = console) {
  if (argv.length > 0) {
    io.error(
      "Usage: node scripts/check-deploy-artifacts.mjs\n\n" +
        "Run from the project root after `deno task build`.",
    );
    return 1;
  }

  try {
    const result = checkDeployArtifacts();
    io.log(
      `Deployment artefacts OK: Worker "${result.name}" ` +
        `(${path.relative(process.cwd(), result.workerEntry)}), ` +
        `assets ${path.relative(process.cwd(), result.assetsDirectory)} ` +
        `(binding ${result.binding}).`,
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

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPoint === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
