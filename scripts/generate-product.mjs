/**
 * Generate a product tree from this generator.
 *
 * The generator is the manufacturing system; the generated project is the
 * product. This script copies an explicit allowlist (`product-manifest.mjs`)
 * into a fresh destination, rewrites the product's task list so it references
 * only files it received, and then performs identity substitution *in the
 * destination*. The generator tree is never modified.
 *
 * Exit codes: 0 generated or dry run, 1 usage/name error, 2 destination state
 * error, 3 copy or write failure.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "./lib/fs.mjs";
import path from "./lib/path.mjs";
import {
  assertManifestDisjoint,
  GENERATOR_ONLY,
  productPaths,
} from "./product-manifest.mjs";
import { initialiseProject, validateProjectName } from "./init-project.mjs";
import {
  createGitRunner,
  releaseProvenance,
  renderSource,
  SOURCE_FILE,
} from "./lib/toolchain/provenance.mjs";
import { generatorInstallationRoot } from "./lib/toolchain/runtime.mjs";
import { treeDigest } from "./lib/toolchain/tree-digest.mjs";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_STATE = 2;
export const EXIT_WRITE = 3;

/** Tasks that only make sense in the generator. */
export const GENERATOR_ONLY_TASKS = Object.freeze([
  "contract:refresh",
  "edge:verify",
  "test:edge",
  "test:toolchain",
  "test:init",
  "init:project",
  "product:generate",
  // Toolchain management belongs to the manufacturing system. A product does
  // not manage or re-pin the toolchain that created it: its `.mise.toml` is the
  // projection it inherited, and `toolchain.toml` plus the resolver are not
  // copied. Keeping these tasks in a product would point at absent files.
  // `toolchain:prepare` owns the whole lifecycle; `--check` is its verification
  // mode, so there is no separate `toolchain:check` task to keep in step.
  "toolchain:install",
  "toolchain:prepare",
  "test:toolchain-config",
  // The generator's own regression suite generates product trees and has no
  // meaning inside one; it must never enter the product's validation chain.
  "test:generator",
  // Release construction (clean tree, annotated tag, tag/commit equality) needs
  // git and the generator's release state, and imports the generator-only digest
  // implementation. The product's equivalent is `test:provenance-source`.
  "test:provenance",
]);

/**
 * The product's own validation chain, in dependency order.
 *
 * Every independent check and test suite runs before the strict contract gate,
 * exactly as in the generator's `validate`: a contract the product has not yet
 * had approved therefore cannot hide its own suites. The gate stays fatal and
 * stays last.
 */
export const PRODUCT_VALIDATE = Object.freeze([
  "fmt:check",
  "lint",
  "check:client",
  "check:worker",
  "check:node-boundary",
  "test:worker",
  "test:scripts",
  "test:deploy",
  "test:boundary",
  "test:contracts",
  "test:provenance-source",
  "test:github-output",
  "test:ci-workflow",
  "test:vite",
  "test:wrangler-types",
  "test:wrangler-dry-run",
  "test:no-node",
  "check:contracts",
]);

export class GenerationError extends Error {
  constructor(message, exitCode = EXIT_USAGE) {
    super(message);
    this.name = "GenerationError";
    this.exitCode = exitCode;
  }
}

function fail(message, exitCode) {
  throw new GenerationError(message, exitCode);
}

/** Fail unless the destination is absent or an empty directory. */
export function assertDestinationAvailable(destination) {
  if (!existsSync(destination)) return;
  if (!statSync(destination).isDirectory()) {
    fail(
      `destination exists and is not a directory: ${destination}`,
      EXIT_STATE,
    );
  }
  if (readdirSync(destination).length > 0) {
    fail(
      `refusing to write into a non-empty directory: ${destination}. ` +
        `Generation never overwrites an existing project.`,
      EXIT_STATE,
    );
  }
}

/** Copy one manifest entry, recursively for directories. */
function copyEntry(sourceRoot, destinationRoot, relative) {
  const source = path.join(sourceRoot, relative);
  const target = path.join(destinationRoot, relative);

  if (!existsSync(source)) {
    fail(`product manifest lists a missing path: ${relative}`, EXIT_STATE);
  }

  const info = statSync(source);
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source).sort()) {
      copyEntry(sourceRoot, destinationRoot, `${relative}/${name}`);
    }
    return;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
  chmodSync(target, info.mode & 0o777);
}

/** Rewrite the product's task list so it references only copied files. */
export function productTasks(tasks) {
  const next = { ...tasks };

  for (const name of GENERATOR_ONLY_TASKS) delete next[name];
  next["test:contracts"] =
    "bash scripts/deno-no-node.sh deno test --allow-read --allow-write --allow-env scripts/contracts.verify.test.mjs";
  next["validate"] = `bash scripts/deno-no-node.sh bash -c '${
    PRODUCT_VALIDATE.map((name) => `deno task ${name}`).join(" && ")
  }'`;

  return next;
}

/** Apply the task rewrite to the product's deno.json and package.json. */
export function rewriteProductMetadata(destinationRoot) {
  const denoPath = path.join(destinationRoot, "deno.json");
  const deno = JSON.parse(readFileSync(denoPath, "utf8"));
  deno.tasks = productTasks(deno.tasks);
  writeFileSync(denoPath, `${JSON.stringify(deno, null, 2)}\n`);

  const packagePath = path.join(destinationRoot, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.scripts = productTasks(pkg.scripts ?? {});
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Assert that no generator-only artefact reached the destination. */
export function assertProductBoundary(destinationRoot) {
  const leaked = GENERATOR_ONLY.filter((entry) =>
    existsSync(path.join(destinationRoot, entry))
  );

  if (leaked.length > 0) {
    fail(
      `generator-only artefacts reached the product: ${leaked.join(", ")}`,
      EXIT_STATE,
    );
  }
}

/**
 * Generate a product tree. Returns the destination path.
 *
 * `root` is the generator root; `destination` must be absent or empty.
 */
export function generateProduct({
  root = Deno.cwd(),
  destination,
  name,
  log = () => {},
} = {}) {
  if (typeof destination !== "string" || destination.length === 0) {
    fail("a destination directory is required (--into DIR)");
  }
  const validated = validateProjectName(name);
  assertManifestDisjoint();

  const target = path.resolve(destination);
  if (target === path.resolve(root)) {
    fail("destination must differ from the generator root", EXIT_STATE);
  }
  assertDestinationAvailable(target);

  try {
    mkdirSync(target, { recursive: true });
    for (const relative of productPaths()) {
      copyEntry(root, target, relative);
    }
  } catch (error) {
    if (error instanceof GenerationError) throw error;
    fail(`copying the product failed: ${error.message}`, EXIT_WRITE);
  }

  rewriteProductMetadata(target);

  // Identity substitution happens only in the destination.
  initialiseProject({ root: target, name: validated, log });
  assertProductBoundary(target);

  log(`Generated product "${validated}" in ${target}.`);
  return target;
}

function usage() {
  return [
    "Generate a product tree from this generator.",
    "",
    "Usage:",
    "  deno task product:generate <project-name> --into DIR [--dry-run] [--toolchain-ref TAG]",
    "",
    "The destination must be absent or empty. Only the artefacts listed in",
    "scripts/product-manifest.mjs are copied; the generator tree is unchanged.",
  ].join("\n");
}

/** CLI entry point; returns an exit code. */
export async function main(argv = Deno.args, io = console) {
  try {
    const positional = [];
    let destination;
    let dryRun = false;
    let toolchainRef;

    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === "--help" || argument === "-h") {
        io.log(usage());
        return EXIT_OK;
      }
      if (argument === "--dry-run" || argument === "-n") {
        dryRun = true;
        continue;
      }
      if (argument === "--toolchain-ref") {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          fail("--toolchain-ref requires an annotated release tag");
        }
        toolchainRef = value;
        index += 1;
        continue;
      }
      if (argument.startsWith("--toolchain-ref=")) {
        toolchainRef = argument.slice("--toolchain-ref=".length);
        continue;
      }
      if (argument === "--into") {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("-")) {
          fail("--into requires a directory");
        }
        destination = value;
        index += 1;
        continue;
      }
      if (argument.startsWith("--into=")) {
        destination = argument.slice("--into=".length);
        continue;
      }
      if (argument.startsWith("-")) fail(`unknown option ${argument}`);
      positional.push(argument);
    }

    if (positional.length !== 1) {
      fail(`expected one project name\n\n${usage()}`);
    }
    validateProjectName(positional[0]);

    if (dryRun) {
      io.log(`Dry run: would generate "${positional[0]}" in ${destination}.`);
      io.log(`Would copy ${productPaths().length} manifest entries.`);
      io.log(
        toolchainRef === undefined
          ? "Development provenance: no .toolchain-source.json would be written."
          : `Release provenance: would record ${toolchainRef} after verifying its tag, SHA and toolchain digest.`,
      );
      return EXIT_OK;
    }

    // Release provenance is resolved *before* anything is written: a dirty tree,
    // a lightweight or missing tag, or a toolchain that does not match its own
    // record must produce no half-generated product.
    let provenance;
    if (toolchainRef !== undefined) {
      provenance = await releaseProvenance({
        root: Deno.cwd(),
        ref: toolchainRef,
        generatorInstallationRoot: generatorInstallationRoot(),
        run: createGitRunner(),
        digest: treeDigest,
      });
      io.log(
        `[provenance] ${provenance.ref} -> ${provenance.sha} ` +
          `materialisation ${provenance.materialisation}`,
      );
    }

    generateProduct({
      destination,
      name: positional[0],
      log: (message) => io.log(message),
    });

    if (provenance !== undefined) {
      writeFileSync(
        path.join(destination, SOURCE_FILE),
        renderSource(provenance),
      );
      io.log(`[provenance] wrote ${SOURCE_FILE} into the product`);
    } else {
      io.log(
        "[provenance] development generation: no .toolchain-source.json written. " +
          "This product cannot provision its toolchain in CI; use " +
          "`--toolchain-ref <toolchain-YYYY.MM.N>` from a clean release checkout.",
      );
    }

    io.log("The generator tree was not modified.");
    return EXIT_OK;
  } catch (error) {
    if (error instanceof GenerationError) {
      io.error(`Error: ${error.message}`);
      return error.exitCode;
    }
    if (error?.name === "InitError") {
      io.error(`Error: ${error.message}`);
      return error.exitCode ?? EXIT_USAGE;
    }
    throw error;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
