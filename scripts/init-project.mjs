#!/usr/bin/env node
/**
 * Initialise a new project from this starter template.
 *
 * The template stores its identity as one placeholder token. Initialisation is
 * a two-phase operation:
 *
 *   1. Read and validate the whole project state, then build every replacement
 *      in memory. Nothing is written during this phase.
 *   2. Stage the new contents in temporary files next to their targets, then
 *      rename each staged file over its target. Each individual rename is
 *      atomic, but the five renames are not one transaction: a failure part
 *      way through leaves some targets updated and is handled by best-effort
 *      rollback, which can itself fail.
 *
 * Only an untouched template is initialised. A fully initialised project is a
 * no-op. Any other state (partially initialised, customised or inconsistent)
 * aborts without writing, so customised values are never overwritten.
 *
 * The filesystem checks below are snapshots, not locks. Initialisation assumes
 * nothing else is modifying the project tree while it runs; see applyChanges
 * for exactly what is and is not guaranteed.
 *
 * Exit codes: 0 success/no-op/dry-run, 1 usage/name error, 2 project state
 * error, 3 write failure.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER = "__PROJECT_NAME__";
export const WORKER_SUFFIX = "-worker";

/** npm package.json name limit. */
export const MAX_PACKAGE_NAME_LENGTH = 214;
/** Cloudflare Worker name limit. */
export const MAX_WORKER_NAME_LENGTH = 63;
/** Longest base name whose derived "<name>-worker" still fits the Worker limit. */
export const MAX_BASE_NAME_LENGTH = MAX_WORKER_NAME_LENGTH -
  WORKER_SUFFIX.length;

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_STATE = 2;
export const EXIT_WRITE = 3;

/** Lowercase, URL-safe characters as required by npm package names. */
const PACKAGE_NAME_PATTERN = /^[a-z0-9._~-]+$/;

/**
 * Conservative Cloudflare Worker name form: lowercase alphanumeric segments
 * separated by single hyphens. Stricter than Wrangler's "dashes only" wording,
 * which keeps the name safe as a workers.dev subdomain label.
 */
const WORKER_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Names npm reserves for itself; they are valid Worker names but not package names. */
const RESERVED_PACKAGE_NAMES = new Set(["node_modules", "favicon.ico"]);

export class InitError extends Error {
  constructor(message, exitCode = EXIT_USAGE) {
    super(message);
    this.name = "InitError";
    this.exitCode = exitCode;
  }
}

/**
 * Every file that carries project identity, the field inside it, and the key
 * used by the identity extractors.
 *
 * `expected` is the number of placeholder occurrences the template ships with.
 */
export const TARGETS = Object.freeze(
  [
    {
      file: "package.json",
      field: 'package "name"',
      identityKey: "packageName",
      expected: 1,
    },
    { file: "index.html", field: "<title>", identityKey: "title", expected: 1 },
    {
      file: "README.md",
      field: "top-level heading",
      identityKey: "heading",
      expected: 1,
    },
    {
      file: "worker/index.ts",
      field: '"/api/health" service identifier',
      identityKey: "workerService",
      expected: 1,
    },
    {
      file: "wrangler.jsonc",
      field: "deployed Cloudflare Worker name",
      identityKey: "wranglerName",
      expected: 1,
    },
  ].map((target) => Object.freeze(target)),
);

const TARGET_FILES = new Set(TARGETS.map((target) => target.file));

/**
 * Tooling that legitimately contains the placeholder token because it defines
 * and documents it. Excluded from the "straggler" scan so the initialiser can
 * also be run against another template copy via --root.
 */
const TEMPLATE_TOOLING_FILES = new Set(["scripts/init-project.mjs"]);

/** Directories that never contain template identity (generated or installed). */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build-wasm",
  ".wrangler",
]);

/** The Worker service identifier derived from a project name. */
export function deriveWorkerServiceName(name) {
  return `${name}${WORKER_SUFFIX}`;
}

/**
 * Validate a project name against both naming conventions and return it.
 *
 * The name must be valid as an npm package.json name *and* as a Cloudflare
 * Worker name. The derived "<name>-worker" service identifier must also fit
 * Cloudflare's Worker-name length limit.
 */
export function validateProjectName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new InitError(
      "A project name is required. Pass it as the first argument, for example `node scripts/init-project.mjs my-app`.",
    );
  }

  if (name.length > MAX_PACKAGE_NAME_LENGTH) {
    throw new InitError(
      `Invalid project name ${
        JSON.stringify(name)
      }: npm package names are limited to ${MAX_PACKAGE_NAME_LENGTH} characters, but this one is ${name.length}.`,
    );
  }

  if (!PACKAGE_NAME_PATTERN.test(name)) {
    throw new InitError(
      `Invalid project name ${
        JSON.stringify(name)
      } for a package.json name: use only lowercase letters, digits and the URL-safe characters ".", "_", "~" and "-".`,
    );
  }

  if (name.startsWith(".") || name.startsWith("_")) {
    throw new InitError(
      `Invalid project name ${
        JSON.stringify(name)
      } for a package.json name: npm package names cannot start with "." or "_".`,
    );
  }

  if (RESERVED_PACKAGE_NAMES.has(name)) {
    throw new InitError(
      `Invalid project name ${
        JSON.stringify(name)
      }: npm reserves that package name.`,
    );
  }

  if (name.length > MAX_WORKER_NAME_LENGTH) {
    throw new InitError(
      `Invalid project name ${
        JSON.stringify(name)
      } for a Cloudflare Worker: Worker names are limited to ${MAX_WORKER_NAME_LENGTH} characters, but this one is ${name.length}.`,
    );
  }

  const derived = deriveWorkerServiceName(name);
  if (derived.length > MAX_WORKER_NAME_LENGTH) {
    throw new InitError(
      `Invalid project name ${
        JSON.stringify(name)
      }: the derived Worker service name ${
        JSON.stringify(derived)
      } is ${derived.length} characters, but Cloudflare Worker names are limited to ${MAX_WORKER_NAME_LENGTH}. Use a name of at most ${MAX_BASE_NAME_LENGTH} characters so the "${WORKER_SUFFIX}" suffix fits.`,
    );
  }

  if (!WORKER_NAME_PATTERN.test(name)) {
    throw new InitError(
      `Invalid project name ${
        JSON.stringify(name)
      } for a Cloudflare Worker: Worker names may contain only lowercase letters, digits and single hyphens, and must start and end with a letter or digit.`,
    );
  }

  if (!WORKER_NAME_PATTERN.test(derived)) {
    throw new InitError(
      `Invalid project name ${
        JSON.stringify(name)
      }: the derived Worker service name ${
        JSON.stringify(derived)
      } is not a valid Cloudflare Worker name.`,
    );
  }

  return name;
}

/** Count literal (non-overlapping) occurrences of a token in a string. */
export function countOccurrences(text, token) {
  let count = 0;
  let index = 0;

  while ((index = text.indexOf(token, index)) !== -1) {
    count += 1;
    index += token.length;
  }

  return count;
}

/** List repository files, preferring git's view (tracked + untracked, not ignored). */
export function listRepositoryFiles(root) {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );

    return output.split("\0").filter(Boolean);
  } catch {
    // Not a git checkout (e.g. an exported copy or a test fixture): walk instead.
    return walkFiles(root);
  }
}

function walkFiles(directory, prefix = "") {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Never follow symlinks: they can point outside the project.
    if (entry.isSymbolicLink()) continue;

    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      files.push(...walkFiles(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }

  return files;
}

/** Find every file that still contains the placeholder token. */
export function scanForPlaceholders(root, files = listRepositoryFiles(root)) {
  const hits = [];

  for (const file of files) {
    let contents;

    try {
      contents = readFileSync(path.join(root, file));
    } catch {
      continue; // Deleted between listing and reading, unreadable, etc.
    }

    if (contents.includes(0)) continue; // Binary file: identity is textual.

    const count = countOccurrences(contents.toString("utf8"), PLACEHOLDER);
    if (count > 0) hits.push({ file, count });
  }

  return hits;
}

/** Extract the package.json "name" value, or null when it cannot be read. */
function extractPackageName(text) {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

/** Extract exactly one <title> value, or null when absent/ambiguous. */
function extractTitle(text) {
  const matches = [...text.matchAll(/<title>([\s\S]*?)<\/title>/gi)];
  if (matches.length !== 1) return null;
  return matches[0][1].trim();
}

/** Extract the first top-level README heading, or null when absent. */
function extractHeading(text) {
  const firstContentLine = text.split(/\r?\n/).find((line) =>
    line.trim() !== ""
  );
  if (firstContentLine === undefined) return null;

  const match = /^#\s+(.+?)\s*$/.exec(firstContentLine);
  return match ? match[1] : null;
}

/** Extract exactly one `service: "..."` value from the Worker source. */
function extractWorkerService(text) {
  const matches = [...text.matchAll(/\bservice\s*:\s*"([^"]*)"/g)];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

/** Extract the wrangler.jsonc name, tolerating JSONC comments via a fallback. */
function extractWranglerName(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.name === "string") return parsed.name;
  } catch {
    // JSONC comments: fall through to the narrow field extraction below.
  }

  const matches = [...text.matchAll(/"name"\s*:\s*"([^"]*)"/g)];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

const EXTRACTORS = Object.freeze({
  packageName: extractPackageName,
  title: extractTitle,
  heading: extractHeading,
  workerService: extractWorkerService,
  wranglerName: extractWranglerName,
});

/** Read every identity value from a map of target file -> contents. */
export function readIdentity(contentsByFile) {
  const identity = {};

  for (const target of TARGETS) {
    identity[target.identityKey] = EXTRACTORS[target.identityKey](
      contentsByFile.get(target.file),
    );
  }

  return identity;
}

function expectedTemplateIdentity() {
  return {
    packageName: PLACEHOLDER,
    title: PLACEHOLDER,
    heading: PLACEHOLDER,
    workerService: deriveWorkerServiceName(PLACEHOLDER),
    wranglerName: PLACEHOLDER,
  };
}

function expectedInitialisedIdentity(name) {
  return {
    packageName: name,
    title: name,
    heading: name,
    workerService: deriveWorkerServiceName(name),
    wranglerName: name,
  };
}

function matchesIdentity(identity, expected) {
  return TARGETS.every((target) =>
    identity[target.identityKey] === expected[target.identityKey]
  );
}

function formatIdentityValue(value) {
  return value === null ? "<not found>" : JSON.stringify(value);
}

function describeTargets(counts, identity) {
  return TARGETS.map(
    (target) =>
      `  ${target.file}: ${
        counts.get(target.file)
      } placeholder(s); ${target.field} = ${
        formatIdentityValue(identity[target.identityKey])
      }`,
  ).join("\n");
}

/** Resolve the project root once so redirected targets can be detected. */
function realProjectRoot(root) {
  try {
    return realpathSync(root);
  } catch (error) {
    throw new InitError(
      `Cannot read the project root ${root} (${error.message}). No files were changed.`,
      EXIT_STATE,
    );
  }
}

/** True when `realTarget` is a file strictly inside `realRoot`. */
function isInsideRoot(realRoot, realTarget) {
  const relative = path.relative(realRoot, realTarget);

  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

/**
 * Read one identity file as it exists during inspection, rejecting symbolic
 * links, directories and special files, and any path that currently resolves
 * outside the project root (for example through a symlinked directory).
 *
 * These are inspection-time checks; they do not lock the tree (see
 * applyChanges).
 */
function readTargetFile(root, target, realRoot) {
  const absolute = path.join(root, target.file);
  let stats;

  try {
    stats = lstatSync(absolute);
  } catch (error) {
    throw new InitError(
      `Cannot read ${target.file} (${error.message}). No files were changed.`,
      EXIT_STATE,
    );
  }

  if (stats.isSymbolicLink()) {
    throw new InitError(
      `Cannot initialise: ${target.file} is a symbolic link. Identity files must be regular files; replace the link with the file it points to. No files were changed.`,
      EXIT_STATE,
    );
  }

  if (!stats.isFile()) {
    throw new InitError(
      `Cannot initialise: ${target.file} is not a regular file. Directories and special files cannot carry project identity. No files were changed.`,
      EXIT_STATE,
    );
  }

  let realTarget;
  try {
    realTarget = realpathSync(absolute);
  } catch (error) {
    throw new InitError(
      `Cannot read ${target.file} (${error.message}). No files were changed.`,
      EXIT_STATE,
    );
  }

  if (!isInsideRoot(realRoot, realTarget)) {
    throw new InitError(
      `Cannot initialise: ${target.file} resolves to ${realTarget}, outside the project root ${realRoot}. Refusing to write through a symbolic link that leaves the project. No files were changed.`,
      EXIT_STATE,
    );
  }

  try {
    return readFileSync(absolute, "utf8");
  } catch (error) {
    throw new InitError(
      `Cannot read ${target.file} (${error.message}). No files were changed.`,
      EXIT_STATE,
    );
  }
}

/**
 * Classify the project without modifying anything.
 *
 * Returns one of:
 *   - { state: "template" }    untouched template, safe to initialise
 *   - { state: "initialised" } fully initialised and self-consistent (no-op)
 *
 * Every other state throws an InitError with exit code 2.
 */
export function inspectProject(root, files) {
  const missing = TARGETS.filter((target) =>
    !existsSync(path.join(root, target.file))
  ).map(
    (target) => target.file,
  );

  if (missing.length > 0) {
    throw new InitError(
      `Cannot initialise: required identity file(s) are missing:\n${
        missing
          .map((file) => `  ${file}`)
          .join("\n")
      }\n\nAn untouched template has all ${TARGETS.length} identity files. Restore the missing file(s) from the template. No files were changed.`,
      EXIT_STATE,
    );
  }

  const realRoot = realProjectRoot(root);
  const contents = new Map();
  for (const target of TARGETS) {
    contents.set(target.file, readTargetFile(root, target, realRoot));
  }

  const counts = new Map(
    TARGETS.map((
      target,
    ) => [
      target.file,
      countOccurrences(contents.get(target.file), PLACEHOLDER),
    ]),
  );

  const selfFile = path.relative(root, fileURLToPath(import.meta.url)).split(
    path.sep,
  ).join("/");
  let stragglers;
  try {
    const scanned = files ?? listRepositoryFiles(root);
    stragglers = scanForPlaceholders(root, scanned).filter(
      (hit) =>
        hit.file !== selfFile &&
        !TEMPLATE_TOOLING_FILES.has(hit.file) &&
        !TARGET_FILES.has(hit.file),
    );
  } catch (error) {
    throw new InitError(
      `Cannot scan the project for stray ${PLACEHOLDER} tokens (${error.message}). No files were changed.`,
      EXIT_STATE,
    );
  }

  if (stragglers.length > 0) {
    const detail = stragglers
      .map((hit) => `  ${hit.file} (${hit.count} occurrence(s))`)
      .join("\n");

    throw new InitError(
      `The placeholder token appears outside the ${TARGETS.length} declared identity files:\n${detail}\n\nRefusing to initialise because those occurrences would survive. Remove them, or add the file to TARGETS in scripts/init-project.mjs if it genuinely carries project identity. No files were changed.`,
      EXIT_STATE,
    );
  }

  const identity = readIdentity(contents);
  const allAtExpectedCounts = TARGETS.every(
    (target) => counts.get(target.file) === target.expected,
  );

  if (
    allAtExpectedCounts && matchesIdentity(identity, expectedTemplateIdentity())
  ) {
    return { state: "template", contents, counts, identity };
  }

  const noPlaceholders = TARGETS.every((target) =>
    counts.get(target.file) === 0
  );
  if (noPlaceholders) {
    const declaredName = identity.packageName;

    if (typeof declaredName !== "string" || declaredName.length === 0) {
      throw new InitError(
        `No placeholders remain, so the project may already be initialised, but package.json does not declare a usable "name". Cannot verify a consistent identity. No files were changed.`,
        EXIT_STATE,
      );
    }

    // A consistent identity is only a valid no-op if the agreed name would
    // have been accepted by this initialiser in the first place.
    try {
      validateProjectName(declaredName);
    } catch (error) {
      if (!(error instanceof InitError)) throw error;
      throw new InitError(
        `No placeholders remain, so the project may already be initialised, but package.json declares a name this template cannot represent. ${error.message}\n\nRefusing to accept an invalid project identity. No files were changed.`,
        EXIT_STATE,
      );
    }

    const expected = expectedInitialisedIdentity(declaredName);
    if (matchesIdentity(identity, expected)) {
      return {
        state: "initialised",
        contents,
        counts,
        identity,
        name: declaredName,
      };
    }

    throw new InitError(
      `No placeholders remain, but the identity values are inconsistent:\n${
        describeTargets(
          counts,
          identity,
        )
      }\n\nRefusing to repair or overwrite customised values. No files were changed.`,
      EXIT_STATE,
    );
  }

  const wrongCounts = TARGETS.some((target) =>
    counts.get(target.file) !== target.expected
  );
  const reason = wrongCounts
    ? "has unexpected placeholder counts"
    : "is partially initialised or customised";

  throw new InitError(
    `Cannot initialise: the project ${reason}:\n${
      describeTargets(
        counts,
        identity,
      )
    }\n\nOnly an untouched template (exactly one placeholder in each identity field) or a fully initialised project (no placeholders and consistent identity values) can be processed. No files were changed.`,
    EXIT_STATE,
  );
}

/** Build a compact -/+ preview for the lines that contain the placeholder. */
function buildPreview(before, after) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const preview = [];

  for (let index = 0; index < beforeLines.length; index += 1) {
    if (!beforeLines[index].includes(PLACEHOLDER)) continue;

    preview.push(`- ${beforeLines[index].replace(/\r$/, "")}`);
    preview.push(`+ ${afterLines[index].replace(/\r$/, "")}`);
  }

  return preview;
}

/**
 * Phase 2a: build the complete set of proposed changes in memory and verify
 * that the replacement lands in every expected identity field.
 */
function buildChanges(inspection, name) {
  const expected = expectedInitialisedIdentity(name);
  const changes = [];

  for (const target of TARGETS) {
    const before = inspection.contents.get(target.file);
    const after = before.split(PLACEHOLDER).join(name);

    if (countOccurrences(after, PLACEHOLDER) !== 0) {
      throw new InitError(
        `Internal error: ${target.file} would still contain the placeholder after replacement. No files were changed.`,
        EXIT_STATE,
      );
    }

    const value = EXTRACTORS[target.identityKey](after);
    if (value !== expected[target.identityKey]) {
      throw new InitError(
        `Refusing to initialise ${target.file}: replacing the placeholder would leave ${target.field} as ${
          formatIdentityValue(value)
        } instead of ${
          formatIdentityValue(expected[target.identityKey])
        }. No files were changed.`,
        EXIT_STATE,
      );
    }

    changes.push({
      file: target.file,
      field: target.field,
      replacements: inspection.counts.get(target.file),
      before,
      after,
      preview: buildPreview(before, after),
    });
  }

  return changes;
}

/** Write one temporary file next to its target, preserving the target mode. */
function stageFile(target, contents, mode) {
  const directory = path.dirname(target);
  const base = path.basename(target);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporary = path.join(
      directory,
      `.${base}.init-project-${randomUUID()}.tmp`,
    );

    try {
      writeFileSync(temporary, contents, { flag: "wx", mode: mode & 0o777 });
      chmodSync(temporary, mode & 0o777);
      return temporary;
    } catch (error) {
      // EEXIST means the name was taken by something we must not delete.
      if (error.code === "EEXIST") continue;

      // The file may have been created (and partially written) even though
      // the call failed, so remove it unconditionally. ENOENT is expected
      // when creation itself failed.
      try {
        unlinkSync(temporary);
      } catch {
        // Best effort: the original error is more useful.
      }

      throw error;
    }
  }

  throw new Error(`could not create a unique temporary file for ${target}`);
}

/**
 * Phase 2b: stage every new file first, then rename each staged file over its
 * target.
 *
 * Each rename is atomic, but the set of renames is not a transaction: if one
 * fails, targets renamed before it already contain new contents. The staged
 * temporary files are removed and completed renames are rolled back in reverse
 * order using the contents captured during validation. Rollback is best effort:
 * it can fail too (for example if the directory has become read-only), and the
 * error then names the files that may be partially initialised.
 *
 * Path safety: every operation re-resolves the lexical path from `root`, and
 * Node has no renameat/openat equivalent, so the containment checks in
 * `inspectProject` and the `lstatSync` below are snapshots rather than locks.
 * The `lstatSync` refusal covers only a symbolic link at the final path
 * component: it stops this code from replacing such a link, but it cannot see a
 * parent directory that was replaced by a symbolic link after inspection.
 * Consequently, a concurrent process that swaps a directory for a link can
 * redirect staging, replacement or rollback outside the root. This function is
 * not hardened against concurrent tampering with the tree.
 *
 * Rollback does not follow a symlink at the final component: `rename` replaces
 * the link itself rather than its target. A redirected parent directory would
 * still redirect rollback, as it would the original write.
 *
 * Exported so tests can exercise the commit and rollback path directly.
 */
export function applyChanges(root, changes) {
  const staged = [];
  const renamed = [];
  let operation = "preparing the changes";

  try {
    for (const change of changes) {
      operation = `staging ${change.file}`;
      const target = path.join(root, change.file);
      const linkStats = lstatSync(target);

      if (linkStats.isSymbolicLink()) {
        throw new Error(
          `${change.file} is a symbolic link; refusing to replace it`,
        );
      }

      staged.push({
        change,
        target,
        temporary: stageFile(target, change.after, statSync(target).mode),
      });
    }

    for (const entry of staged) {
      operation = `replacing ${entry.change.file}`;
      renameSync(entry.temporary, entry.target);
      renamed.push(entry);
    }
  } catch (error) {
    for (const entry of staged) {
      try {
        unlinkSync(entry.temporary);
      } catch {
        // The temporary file was already renamed or never existed.
      }
    }

    const rollbackFailures = [];
    for (const entry of [...renamed].reverse()) {
      let temporary = null;

      try {
        const mode = statSync(entry.target).mode;
        temporary = stageFile(entry.target, entry.change.before, mode);
        renameSync(temporary, entry.target);
      } catch {
        if (temporary !== null) {
          try {
            unlinkSync(temporary);
          } catch {
            // Best effort: the rollback failure is more important.
          }
        }
        rollbackFailures.push(entry.change.file);
      }
    }

    let outcome;
    if (renamed.length === 0) {
      outcome = `No project files were modified. Not initialised: ${
        changes
          .map((change) => change.file)
          .join(", ")
      }.`;
    } else if (rollbackFailures.length === 0) {
      outcome = `Changed files were rolled back: ${
        renamed
          .map((entry) => entry.change.file)
          .join(", ")
      }.`;
    } else {
      outcome = `These files may be partially initialised: ${
        rollbackFailures.join(
          ", ",
        )
      }. Restore them from version control.`;
    }

    throw new InitError(
      `Writing the initialised files failed while ${operation}: ${error.message} ${outcome}`,
      EXIT_WRITE,
    );
  }
}

/**
 * Initialise the project identity.
 *
 * Everything is read and validated before anything is written. Returns a result
 * object; throws InitError with a meaningful exit code on failure.
 */
export function initialiseProject(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const name = validateProjectName(options.name);
  const dryRun = options.dryRun === true;
  const log = typeof options.log === "function" ? options.log : () => {};

  if (!existsSync(root)) {
    throw new InitError(`Project root not found: ${root}`);
  }

  let rootStats;
  try {
    rootStats = statSync(root);
  } catch (error) {
    throw new InitError(
      `Project root cannot be inspected: ${root} (${error.message}).`,
    );
  }

  if (!rootStats.isDirectory()) {
    throw new InitError(`Project root is not a directory: ${root}`);
  }

  // Phase 1: read and validate all repository state. No writes happen here.
  const inspection = inspectProject(root);

  if (inspection.state === "initialised") {
    log(
      `Project is already initialised as ${
        JSON.stringify(inspection.name)
      }; nothing to do.`,
    );
    return {
      status: "already-initialised",
      name: inspection.name,
      changes: [],
    };
  }

  const changes = buildChanges(inspection, name);
  const publicChanges = changes.map((
    { file, field, replacements, preview },
  ) => ({
    file,
    field,
    replacements,
    preview,
  }));

  if (dryRun) {
    log(
      `Dry run: would initialise the project as ${
        JSON.stringify(name)
      } in ${root}.`,
    );
    log("");

    for (const change of changes) {
      log(
        `${change.file} (${change.field}) - ${change.replacements} replacement(s):`,
      );
      for (const line of change.preview) log(`  ${line}`);
      log("");
    }

    log(
      "No files were changed. Re-run without --dry-run to apply these changes.",
    );
    return { status: "dry-run", name, changes: publicChanges };
  }

  // Phase 2: write only after every check has passed.
  applyChanges(root, changes);

  log(`Initialised the project as ${JSON.stringify(name)}:`);
  for (const change of changes) {
    log(
      `  ${change.file}: ${change.replacements} replacement(s) (${change.field})`,
    );
  }
  log("");
  log("Review the changes with `git diff` before committing.");

  return { status: "initialised", name, changes: publicChanges };
}

/** Human-readable CLI help, including the exact placeholder token. */
export function usage() {
  return [
    "Initialise a new project from this starter template.",
    "",
    "Usage:",
    "  node scripts/init-project.mjs <project-name> [--dry-run] [--root DIR]",
    "",
    `Replaces the template placeholder (${PLACEHOLDER}) in:`,
    ...TARGETS.map((target) => `  ${target.file.padEnd(18)} ${target.field}`),
    "",
    "Options:",
    "  -n, --dry-run   preview the changes without writing any file",
    "      --root DIR  project root to initialise (default: current directory)",
    "  -h, --help      show this help",
    "",
    "Project name rules:",
    '- npm package name: lowercase, URL-safe, not starting with "." or "_" and',
    "  not a reserved name (for example node_modules).",
    "- Cloudflare Worker name: lowercase letters, digits and single hyphens,",
    "  starting and ending with a letter or digit.",
    `- the derived Worker service name (<name>${WORKER_SUFFIX}) must fit Cloudflare's`,
    `  ${MAX_WORKER_NAME_LENGTH}-character limit, so <name> may be at most ${MAX_BASE_NAME_LENGTH} characters.`,
    "",
    "The project must be an untouched template. A fully initialised project is a",
    "no-op; partially initialised, customised or inconsistent projects abort",
    "without changing anything. Initialisation is intended to run once.",
    "",
    "Exit codes:",
    "  0  initialised, dry run, or already initialised (no-op)",
    "  1  usage or project-name validation error",
    "  2  project state error (missing files, placeholder issues, partial/customised identity)",
    "  3  writing the initialised files failed",
    "",
    "The placeholder Worker name is deliberately invalid, so dev, build and",
    "deploy refuse to run on an uninitialised copy.",
  ].join("\n");
}

/** Parse CLI arguments into options, rejecting unknown flags. */
export function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
    name: undefined,
    root: process.cwd(),
  };
  const positional = [];
  let endOfOptions = false;
  let rootSpecified = false;

  const setRoot = (value) => {
    // Compared literally: no canonicalisation, so equivalent spellings such as
    // "/x" and "/x/" are treated as a conflict and fail closed.
    if (rootSpecified && value !== options.root) {
      throw new InitError(
        `--root was given more than once with different values: ${
          JSON.stringify(options.root)
        } and ${
          JSON.stringify(value)
        }. Values are compared literally, so use one spelling.`,
      );
    }

    options.root = value;
    rootSpecified = true;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (endOfOptions) {
      positional.push(argument);
    } else if (argument === "--") {
      endOfOptions = true;
    } else if (argument === "--dry-run" || argument === "-n") {
      options.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--root") {
      const value = argv[index + 1];
      // An option-like next token is a forgotten value, not a directory name.
      if (value === undefined || value.length === 0 || value.startsWith("-")) {
        throw new InitError(
          '--root requires a directory argument. Use --root=DIR when the directory name itself begins with "-".',
        );
      }
      setRoot(value);
      index += 1;
    } else if (argument.startsWith("--root=")) {
      const value = argument.slice("--root=".length);
      if (value.length === 0) {
        throw new InitError("--root requires a directory argument.");
      }
      setRoot(value);
    } else if (argument.startsWith("-")) {
      throw new InitError(
        `Unknown option ${JSON.stringify(argument)}.\n\n${usage()}`,
      );
    } else {
      positional.push(argument);
    }
  }

  if (positional.length > 1) {
    throw new InitError(
      `Expected one project name, but received ${positional.length}: ${
        positional
          .map((value) => JSON.stringify(value))
          .join(", ")
      }.\n\n${usage()}`,
    );
  }

  options.name = positional[0];
  return options;
}

/** CLI entry point; returns a process exit code instead of exiting directly. */
export function main(argv = process.argv.slice(2), io = console) {
  try {
    const options = parseArgs(argv);

    if (options.help) {
      io.log(usage());
      return EXIT_OK;
    }

    if (options.name === undefined) {
      throw new InitError(`A project name is required.\n\n${usage()}`);
    }

    initialiseProject({
      ...options,
      log: (message) => io.log(message),
    });

    return EXIT_OK;
  } catch (error) {
    if (error instanceof InitError) {
      io.error(`Error: ${error.message}`);
      return error.exitCode;
    }

    throw error;
  }
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPoint === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
