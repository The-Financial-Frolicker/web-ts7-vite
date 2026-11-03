/**
 * Capability-boundary enforcement: the configuration invariants that the
 * capability diagnostics depend on.
 *
 * The delivered-code boundary rests on two mechanisms, and this file verifies
 * the premise of the first one:
 *
 *   1. Compiler configuration invariants (this file). The application is free of
 *      Node only because `@types/node` is absent and `types`/`lib` do not
 *      reintroduce it. A check that relies on configuration verifies its premise.
 *   2. TypeScript semantic diagnostics (`check:client`, `check:worker`). The
 *      compiler resolves imports, aliases and ambient declarations, and reports
 *      `node:fs` and `process` as TS2591 in both projects.
 *   3. Delivered-artefact inspection (`check:deploy`). The emitted Worker
 *      bundle, the client bundles and the published WASM glue are inspected for
 *      Node built-ins, CommonJS constructs and Node globals.
 *
 * This file deliberately does not scan source text. Textual matching cannot tell
 * a capability from a mention of one, and a home-grown tokeniser implies
 * semantic assurance it cannot give: the compiler resolves the program, and
 * `check:deploy` inspects what is actually shipped. A capability that reaches
 * the output is caught there whatever the source looked like.
 *
 * Residual gaps, recorded rather than hidden: an unused local
 * `declare module "node:*"` and an authoring-time `@ts-ignore` are no longer
 * reported early. Their delivered consequence still has to appear in an emitted
 * bundle to matter, and `check:deploy` inspects those. Computed or non-literal
 * dynamic imports remain outside every layer.
 *
 * Exit codes: 0 no violation, 1 violation or usage error.
 */
import { readFileSync } from "./lib/fs.mjs";
import path from "./lib/path.mjs";

/** The ambient type package the client is allowed to load. */
export const REQUIRED_CLIENT_TYPE = "vite/client";

/** Node's ambient types; their presence would disable the compiler diagnostics. */
export const NODE_TYPES_PACKAGE = "@types/node";

/** `nodejs_compat` and its variants, plus the legacy alias. */
export const FORBIDDEN_COMPATIBILITY_FLAG = /^(?:nodejs_als|nodejs_compat)/;

/** A `lib` entry naming a Node library would reintroduce Node globals. */
const NODE_LIBRARY = /^node/i;

/** A dependency entry naming Node's ambient types, with or without a version. */
const NODE_TYPES_SPECIFIER = /^(?:npm:)?@types\/node(?:@|$)/;

export const CLIENT_TSCONFIG = "tsconfig.json";
export const WORKER_TSCONFIG = "worker/tsconfig.json";
export const WRANGLER_CONFIG = "wrangler.jsonc";
export const PACKAGE_JSON = "package.json";
export const DENO_LOCK = "deno.lock";

/** Every file whose contents the configuration invariants depend on. */
export const REQUIRED_CONFIG_FILES = Object.freeze([
  PACKAGE_JSON,
  DENO_LOCK,
  CLIENT_TSCONFIG,
  WORKER_TSCONFIG,
  WRANGLER_CONFIG,
]);

/** The configuration invariants layer 2 depends on, in check order. */
export const CONFIG_INVARIANTS = Object.freeze([
  "no package.json dependency section depends on @types/node",
  "deno.lock does not pin @types/node",
  "client tsconfig types include vite/client",
  "worker tsconfig types are empty",
  "no tsconfig lib names a Node library",
  "wrangler configuration enables no nodejs_compat* flag",
]);

export class NodeBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "NodeBoundaryError";
  }
}
/**
 * Remove `//` line comments and block comments from JSON-with-comments text.
 *
 * Only string state is tracked, because that is the one way a comment delimiter
 * can legitimately appear in JSON: `"https://example.test"` must survive intact.
 * This is a JSON reader, not a JavaScript scanner, and it is used only to parse
 * `tsconfig.json` and `wrangler.jsonc`.
 */
export function stripJsonComments(text) {
  let stripped = "";
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (character === '"') {
      const start = index;
      index += 1;

      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }

      stripped += text.slice(start, index);
      continue;
    }

    if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }

    if (character === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      index = close === -1 ? text.length : close + 2;
      // Keep tokens apart so `1/*x*/2` cannot become `12`.
      stripped += " ";
      continue;
    }

    stripped += character;
    index += 1;
  }

  return stripped;
}

function loadJson(projectRoot, file, commentTolerant, report) {
  let text;
  try {
    text = readFileSync(path.join(projectRoot, file), "utf8");
  } catch {
    report(file, "cannot be read, so its capability invariants are unverified");
    return null;
  }

  try {
    const json = JSON.parse(commentTolerant ? stripJsonComments(text) : text);
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      report(file, "must contain a JSON object");
      return null;
    }
    return json;
  } catch (error) {
    report(
      file,
      `cannot be parsed (${error.message}), so its capability invariants are ` +
        "unverified",
    );
    return null;
  }
}

/** Every `@types/node` reference in a lockfile, whatever its schema version. */
export function findLockedNodeTypes(lock) {
  const found = new Set();

  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (value === null || typeof value !== "object") {
      if (typeof value === "string" && NODE_TYPES_SPECIFIER.test(value)) {
        found.add(value);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (NODE_TYPES_SPECIFIER.test(key)) found.add(key);
      visit(child);
    }
  };

  visit(lock);
  return [...found].sort();
}

function checkTsconfig(projectRoot, file, expectation, report) {
  const config = loadJson(projectRoot, file, true, report);
  if (config === null) return;

  const options = config.compilerOptions;
  if (
    options === null || typeof options !== "object" || Array.isArray(options)
  ) {
    report(file, 'has no "compilerOptions" object');
    return;
  }

  const types = options.types;
  if (!Array.isArray(types)) {
    report(
      file,
      "compilerOptions.types must be an explicit array, otherwise every " +
        "installed @types package (including @types/node) is loaded",
    );
  } else {
    if (expectation.mustInclude && !types.includes(expectation.mustInclude)) {
      report(
        file,
        `compilerOptions.types must include ${
          JSON.stringify(expectation.mustInclude)
        }`,
      );
    }
    if (expectation.mustBeEmpty && types.length > 0) {
      report(
        file,
        `compilerOptions.types must be empty, but declares ${
          JSON.stringify(types)
        }`,
      );
    }
    if (types.includes("node")) {
      report(file, 'compilerOptions.types must not include "node"');
    }
  }

  if (options.lib === undefined) return;
  if (!Array.isArray(options.lib)) {
    report(file, "compilerOptions.lib must be an array when present");
    return;
  }

  for (const entry of options.lib) {
    if (typeof entry === "string" && NODE_LIBRARY.test(entry)) {
      report(
        file,
        "compilerOptions.lib must not name a Node library, but declares " +
          JSON.stringify(entry),
      );
    }
  }
}

function checkCompatibilityFlags(flags, file, report) {
  if (flags === undefined) return;
  if (!Array.isArray(flags)) {
    report(file, '"compatibility_flags" must be an array when present');
    return;
  }

  for (const flag of flags) {
    if (typeof flag !== "string") {
      report(file, '"compatibility_flags" entries must be strings');
      continue;
    }

    if (FORBIDDEN_COMPATIBILITY_FLAG.test(flag)) {
      report(
        file,
        `"compatibility_flags" must not enable ${
          JSON.stringify(flag)
        }; it would expose Node globals to the Worker`,
      );
    }
  }
}

/** Configuration violations (layer 1). */
export function findConfigInvariantViolations(root) {
  const projectRoot = path.resolve(root);
  const violations = [];
  const report = (file, message) =>
    violations.push({ file, line: 0, column: 0, message });

  const packageJson = loadJson(projectRoot, PACKAGE_JSON, false, report);
  if (packageJson !== null) {
    for (
      const section of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]
    ) {
      const dependencies = packageJson[section];
      if (
        !dependencies || typeof dependencies !== "object" ||
        Array.isArray(dependencies)
      ) {
        continue;
      }

      if (!Object.hasOwn(dependencies, NODE_TYPES_PACKAGE)) continue;
      report(
        PACKAGE_JSON,
        `"${section}" must not depend on ${
          JSON.stringify(NODE_TYPES_PACKAGE)
        }; it would re-enable Node globals for the type checker`,
      );
    }
  }

  const lock = loadJson(projectRoot, DENO_LOCK, false, report);
  if (lock !== null) {
    for (const reference of findLockedNodeTypes(lock)) {
      report(
        DENO_LOCK,
        `pins ${JSON.stringify(reference)}; ${
          JSON.stringify(NODE_TYPES_PACKAGE)
        } must not be installed`,
      );
    }
  }

  checkTsconfig(
    projectRoot,
    CLIENT_TSCONFIG,
    { mustInclude: REQUIRED_CLIENT_TYPE },
    report,
  );
  checkTsconfig(projectRoot, WORKER_TSCONFIG, { mustBeEmpty: true }, report);

  const wrangler = loadJson(projectRoot, WRANGLER_CONFIG, true, report);
  if (wrangler !== null) {
    checkCompatibilityFlags(
      wrangler.compatibility_flags,
      WRANGLER_CONFIG,
      report,
    );
  }

  return violations;
}
/** Render violations with their location, plus the policy context. */
export function formatViolations(violations) {
  const lines = violations.map((violation) =>
    violation.line > 0
      ? `  ${violation.file}:${violation.line}:${violation.column}  ` +
        violation.message
      : `  ${violation.file}  ${violation.message}`
  );

  return [
    "The capability boundary is violated:",
    "",
    ...lines,
    "",
    "Layers: compiler configuration (above), TypeScript diagnostics",
    "(check:client, check:worker), delivered artefacts (check:deploy). Source",
    'text is not scanned. See "Node.js dependency boundary" in README.md.',
  ].join("\n");
}

/**
 * Run the configuration invariants.
 *
 * Returns `{ root, configFiles, invariants }` on success and throws
 * NodeBoundaryError listing every violation otherwise. Reading no configuration
 * file at all is an error: it would mean the check passed without inspecting
 * anything.
 */
export function checkCapabilityBoundary(root = Deno.cwd()) {
  const projectRoot = path.resolve(root);

  const configFiles = REQUIRED_CONFIG_FILES.filter((file) => {
    try {
      readFileSync(path.join(projectRoot, file));
      return true;
    } catch {
      return false;
    }
  });

  if (configFiles.length === 0) {
    throw new NodeBoundaryError(
      `No configuration file (${REQUIRED_CONFIG_FILES.join(", ")}) could be ` +
        `read in ${projectRoot}. Refusing to pass a check that inspected ` +
        "nothing.",
    );
  }

  const violations = findConfigInvariantViolations(projectRoot);
  if (violations.length > 0) {
    throw new NodeBoundaryError(formatViolations(violations));
  }

  return {
    root: projectRoot,
    configFiles,
    invariants: CONFIG_INVARIANTS.length,
  };
}

/** CLI entry point; returns a process exit code instead of exiting directly. */
export function main(argv = Deno.args, io = console) {
  if (argv.length > 0) {
    io.error(
      "Usage: deno run --allow-read --allow-env scripts/check-node-boundary.mjs\n\n" +
        "Run from the project root. No options are accepted.",
    );
    return 1;
  }

  try {
    const result = checkCapabilityBoundary();
    io.log(
      `Capability boundary OK: ${result.invariants} configuration invariant(s) ` +
        `hold across ${result.configFiles.length} configuration file(s); no ` +
        `"@types/node" dependency, no Node tsconfig types or lib, and no ` +
        "nodejs_compat* flag.",
    );
    return 0;
  } catch (error) {
    if (error instanceof NodeBoundaryError) {
      io.error(`Error: ${error.message}`);
      return 1;
    }

    throw error;
  }
}

if (import.meta.main) {
  Deno.exitCode = main();
}
