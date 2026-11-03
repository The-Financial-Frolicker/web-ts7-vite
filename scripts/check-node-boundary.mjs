#!/usr/bin/env node
/**
 * Capability-boundary enforcement, layers 1 and 3 of 4.
 *
 *   1. Compiler configuration invariants (this file). The application is free of
 *      Node only because `@types/node` is absent and `types`/`lib` do not
 *      reintroduce it. A check that relies on configuration verifies its premise.
 *   2. TypeScript semantic diagnostics (`check:client`, `check:worker`). The
 *      compiler resolves imports, aliases and ambient declarations, and reports
 *      `node:fs` and `process` as TS2591 in both projects.
 *   3. Narrow source policy (this file). The two holes the compiler cannot see: a
 *      local ambient module declaration can legitimise `node:`/`cloudflare:`
 *      modules, and a suppression directive can silence the diagnostic layer 2
 *      depends on. Nothing else is inspected; capabilities are not inferred.
 *   4. Delivered-artefact inspection (`check:deploy`).
 *
 * Not enforced at this stage, and recorded as residual gaps: computed or
 * non-literal dynamic imports; `declare global` augmentations; `@ts-nocheck`.
 *
 * Comments, string/template literals and regex literals are excluded from the
 * code rules, and directives are matched only inside comments, so text that
 * mentions a directive or module name cannot fail the check.
 *
 * Exit codes: 0 no violation, 1 violation or usage error.
 */
import { readdirSync, readFileSync, statSync } from "./lib/fs.mjs";
import path from "./lib/path.mjs";

/** Directories holding delivered application source. */
export const PROTECTED_ROOTS = Object.freeze(["src", "worker"]);

/** Files that are not delivered application source. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const SKIPPED_DIRECTORIES = Object.freeze(["node_modules"]);

/** Directives that can silence the diagnostic layer 2 relies on. */
const SUPPRESSION_DIRECTIVE = /@ts-(?:ignore|expect-error)\b/;

/** Ambient module declarations, captured with their specifier. */
const AMBIENT_MODULE_DECLARATION = /declare\s+module\s*(['"])([^'"]+)\1/g;

/** Module namespaces the application must not acquire. */
export const FORBIDDEN_AMBIENT_MODULE_PREFIXES = Object.freeze([
  "node:",
  "cloudflare:",
]);

/** The ambient type package the client is allowed to load. */
export const REQUIRED_CLIENT_TYPE = "vite/client";

/** Node's ambient types; their presence would disable layer 2. */
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
/** Keywords after which a `/` starts a regular expression, not a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** True when the `/` at `index` can start a regular-expression literal. */
function regexAllowedAfter(source, index) {
  let cursor = index - 1;

  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;

  const previous = source[cursor];
  if (!/[A-Za-z0-9_$]/.test(previous)) {
    return previous !== ")" && previous !== "]";
  }

  let start = cursor;
  while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start -= 1;
  return REGEX_PRECEDING_KEYWORDS.has(source.slice(start, cursor + 1));
}

/** Skip a quoted string or template literal, returning the index after it. */
function skipLiteral(source, start) {
  const quote = source[start];
  let index = start + 1;

  while (index < source.length) {
    const character = source[index];

    if (character === "\\") {
      index += 2;
      continue;
    }

    if (character === quote) return index + 1;
    // An unterminated string must not swallow the rest of the file.
    if (character === "\n" && quote !== "`") return index;

    index += 1;
  }

  return index;
}

/** Skip a regex literal and its flags, returning the index after it. */
function skipRegex(source, start) {
  let index = start + 1;
  let inCharacterClass = false;

  while (index < source.length) {
    const character = source[index];

    if (character === "\\") {
      index += 2;
      continue;
    }

    if (character === "\n") return index;

    if (character === "[") {
      inCharacterClass = true;
    } else if (character === "]") {
      inCharacterClass = false;
    } else if (character === "/" && !inCharacterClass) {
      index += 1;
      break;
    }

    index += 1;
  }

  while (index < source.length && /[a-z]/i.test(source[index])) index += 1;

  return index;
}

/**
 * Split source into code spans and comment spans.
 *
 * Only "inside a comment" versus "inside code" matters for this file's rules, so
 * string, template and regex literals are skipped rather than tokenised: a
 * directive inside a string is not a directive, and a `//` inside a regex does
 * not start a comment. This is deliberately not a tokeniser for code analysis.
 */
export function scanSegments(source) {
  const code = [];
  const comments = [];
  const literals = [];
  let index = 0;
  let codeStart = 0;

  const openCodeSpan = (end) => {
    if (end > codeStart) {
      code.push({ text: source.slice(codeStart, end), start: codeStart });
    }
  };

  const openComment = (start, end) => {
    openCodeSpan(start);
    comments.push({ text: source.slice(start, end), start });
    codeStart = end;
  };

  while (index < source.length) {
    const character = source[index];

    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      openComment(index, end);
      index = end;
      continue;
    }

    if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      const end = close === -1 ? source.length : close + 2;
      openComment(index, end);
      index = end;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      const end = skipLiteral(source, index);
      literals.push({ start: index, end });
      index = end;
      continue;
    }

    if (character === "/" && regexAllowedAfter(source, index)) {
      const end = skipRegex(source, index);
      literals.push({ start: index, end });
      index = end;
      continue;
    }

    index += 1;
  }

  openCodeSpan(source.length);
  return { code, comments, literals };
}
function locate(source, offset) {
  const precedingLines = source.slice(0, offset).split("\n");

  return {
    line: precedingLines.length,
    column: precedingLines[precedingLines.length - 1].length + 1,
  };
}

/** Collect protected source files below `root`, relative and sorted. */
export function listSourceFiles(root) {
  const files = [];

  const walk = (directory, prefix) => {
    for (
      const entry of readdirSync(path.join(directory, prefix), {
        withFileTypes: true,
      })
    ) {
      const relative = `${prefix}/${entry.name}`;

      // Never follow symlinks: they can point outside the project.
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
        walk(directory, relative);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (TEST_FILE.test(entry.name)) continue;

      files.push(relative);
    }
  };

  for (const protectedRoot of PROTECTED_ROOTS) {
    let stats;
    try {
      stats = statSync(path.join(root, protectedRoot));
    } catch {
      continue; // An absent root is allowed so reduced checkouts still work.
    }

    if (!stats.isDirectory()) continue;
    walk(root, protectedRoot);
  }

  return files.sort();
}

/**
 * Source-policy violations: the two holes the compiler cannot see.
 *
 * Everything else about application capability is left to the type checker, and
 * non-literal dynamic imports are deliberately not examined.
 */
export function findSourcePolicyViolations(root) {
  const projectRoot = path.resolve(root);
  const violations = [];

  for (const file of listSourceFiles(projectRoot)) {
    const source = readFileSync(path.join(projectRoot, file), "utf8");
    const { code, comments, literals } = scanSegments(source);
    const insideLiteral = (offset) =>
      literals.some((literal) =>
        offset >= literal.start && offset < literal.end
      );

    // Directives count only inside comments, so a string or template literal
    // that mentions one cannot fail the check.
    for (const span of comments) {
      const match = SUPPRESSION_DIRECTIVE.exec(span.text);
      if (match === null) continue;

      violations.push({
        file,
        ...locate(source, span.start + match.index),
        message:
          `uses the TypeScript suppression directive ${
            JSON.stringify(match[0])
          }` +
          "; it can hide the capability diagnostic this boundary depends on",
      });
    }

    // Ambient declarations count only in code, so a comment or string that
    // quotes one cannot fail the check.
    for (const span of code) {
      for (const match of span.text.matchAll(AMBIENT_MODULE_DECLARATION)) {
        const offset = span.start + match.index;
        // A code span still contains its literal text verbatim, so a quoted
        // example would otherwise match.
        if (insideLiteral(offset)) continue;

        const specifier = match[2];
        const forbidden = FORBIDDEN_AMBIENT_MODULE_PREFIXES.some((prefix) =>
          specifier.startsWith(prefix)
        );
        if (!forbidden) continue;

        violations.push({
          file,
          ...locate(source, offset),
          message: `declares the ambient module ${JSON.stringify(specifier)}` +
            "; application source must not introduce Node or Cloudflare " +
            "module capabilities",
        });
      }
    }
  }

  return violations.sort((left, right) =>
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column
  );
}
/** Remove comments while preserving the code that remains. */
export function stripJsonComments(text) {
  return scanSegments(text).code.map((span) => span.text).join(" ");
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
    "(check:client, check:worker), narrow source policy (above), delivered",
    "artefacts (check:deploy). Computed dynamic imports are not statically",
    'prohibited. See "Node.js dependency boundary" in README.md.',
  ].join("\n");
}

/**
 * Run every check this layer owns.
 *
 * Returns `{ root, files, invariants }` on success and throws NodeBoundaryError
 * listing every violation otherwise. An empty file list is an error: it would
 * mean the check passed without inspecting anything.
 */
export function checkCapabilityBoundary(root = Deno.cwd()) {
  const projectRoot = path.resolve(root);
  const files = listSourceFiles(projectRoot);

  if (files.length === 0) {
    throw new NodeBoundaryError(
      `No protected source files found under ${
        PROTECTED_ROOTS.join(" or ")
      } in ${projectRoot}. Refusing to pass a check that inspected nothing.`,
    );
  }

  const violations = [
    ...findConfigInvariantViolations(projectRoot),
    ...findSourcePolicyViolations(projectRoot),
  ];

  if (violations.length > 0) {
    throw new NodeBoundaryError(formatViolations(violations));
  }

  return { root: projectRoot, files, invariants: CONFIG_INVARIANTS.length };
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
      `Capability boundary OK: ${result.files.length} protected source file(s) ` +
        `under ${PROTECTED_ROOTS.join(", ")}; ${result.invariants} ` +
        "configuration invariant(s) hold; no ambient Node/Cloudflare module " +
        "declarations and no TypeScript suppression directives.",
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
