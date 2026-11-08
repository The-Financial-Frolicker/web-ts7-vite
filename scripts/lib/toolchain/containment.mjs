/**
 * Path containment for product-owned installation roots.
 *
 * A product owns exactly one subtree of its project root (`generator/` for the
 * generator, `application/` for the independent application). Every path the
 * installer is about to create, replace or remove must resolve inside that
 * subtree, and the check has to happen before any mutation.
 *
 * The comparison is canonical and separator-aware:
 *
 *   * `.`/`..`/duplicate separators are normalised lexically, so `..` cannot
 *     escape before the comparison happens;
 *   * the longest existing prefix is resolved through `realPathSync`, so a
 *     symlinked ancestor or a symlink at the final component cannot hide an
 *     escape (a destination that does not exist yet is completed lexically
 *     after its nearest existing ancestor);
 *   * membership requires either equality or a following path separator, so a
 *     sibling such as `generator-other` is not mistaken for the subtree.
 *
 * Nothing here is a general filesystem sandbox: it answers exactly one
 * question — "is this candidate inside that permitted subtree?" — and fails
 * closed when it cannot tell.
 */

import { join, sep } from "../path.mjs";

export class ContainmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContainmentError";
  }
}

function fail(message) {
  throw new ContainmentError(message);
}

/** Absolute, lexically normalised path. No filesystem access. */
export function absolutePath(value, label = "path") {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} is empty; an absolute path is required`);
  }
  if (!value.startsWith("/")) {
    fail(
      `${label} ${
        JSON.stringify(value)
      } is not absolute; an absolute path is ` +
        `required so the installation location cannot depend on the working directory`,
    );
  }

  const segments = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        fail(
          `${label} ${JSON.stringify(value)} escapes above the filesystem root`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `/${segments.join("/")}`;
}

/**
 * Canonical form of a path that may not exist yet.
 *
 * The deepest existing ancestor is resolved through the filesystem (following
 * symlinks); the remaining segments are appended unchanged because they do not
 * exist and therefore cannot be links.
 */
export function canonicalPath(value, label = "path") {
  const absolute = absolutePath(value, label);
  const segments = absolute === "/" ? [] : absolute.slice(1).split("/");

  let existing = "/";
  let index = 0;
  for (; index < segments.length; index += 1) {
    const candidate = join(existing, segments[index]);
    let stat;
    try {
      stat = Deno.lstatSync(candidate);
    } catch {
      break;
    }
    // Resolve every existing component, including a symlink at this level, so a
    // link that points outside the permitted subtree is visible to the caller.
    existing = stat.isSymlink || stat.isDirectory
      ? Deno.realPathSync(candidate)
      : candidate;
  }

  const remainder = segments.slice(index);
  if (remainder.length === 0) return existing === "/" ? "/" : existing;
  return join(existing, ...remainder);
}

/** True when `candidate` is `permitted` or lies inside it. */
export function isContained(candidate, permitted) {
  if (typeof candidate !== "string" || typeof permitted !== "string") {
    return false;
  }

  let resolvedCandidate;
  let resolvedPermitted;
  try {
    resolvedCandidate = canonicalPath(candidate);
    resolvedPermitted = canonicalPath(permitted);
  } catch {
    return false;
  }

  if (resolvedCandidate === resolvedPermitted) return true;
  return resolvedCandidate.startsWith(
    resolvedPermitted.endsWith(sep)
      ? resolvedPermitted
      : `${resolvedPermitted}${sep}`,
  );
}

/** Like `isContained`, but rejects equality with the permitted root itself. */
export function isStrictlyContained(candidate, permitted) {
  if (!isContained(candidate, permitted)) return false;
  return canonicalPath(candidate) !== canonicalPath(permitted);
}

/**
 * Require `candidate` to resolve inside `permitted`, or fail closed.
 *
 * `hint` lets a caller explain the ownership rule in its own terms (for example
 * "the generator installation root must be a child of <subroot>").
 */
export function requireContained(candidate, permitted, options = {}) {
  const {
    candidateLabel = "path",
    permittedLabel = "permitted root",
    strict = false,
    hint,
  } = options;

  let resolvedCandidate;
  let resolvedPermitted;
  try {
    resolvedCandidate = canonicalPath(candidate, candidateLabel);
    resolvedPermitted = canonicalPath(permitted, permittedLabel);
  } catch (error) {
    if (error instanceof ContainmentError) {
      fail(`${hint ?? ""} ${error.message}`.trim());
    }
    throw error;
  }

  const inside = strict
    ? isStrictlyContained(resolvedCandidate, resolvedPermitted)
    : isContained(resolvedCandidate, resolvedPermitted);

  if (!inside) {
    fail(
      `${
        hint ? `${hint}: ` : ""
      }${candidateLabel} ${resolvedCandidate} is outside ` +
        `${permittedLabel} ${resolvedPermitted}${
          strict ? " (it must be a strict child)" : ""
        }`,
    );
  }

  return resolvedCandidate;
}
