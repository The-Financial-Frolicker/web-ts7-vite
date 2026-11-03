/**
 * Minimal POSIX path helpers used by the Deno-native project tooling.
 *
 * The repository targets Linux (see README.md), so this module deliberately
 * implements the POSIX subset the scripts use rather than the full Node `path`
 * API. It keeps the same observable behaviour for the operations in use and
 * avoids introducing a JSR dependency and a deno.lock change.
 */

export const sep = "/";

/** Normalise a POSIX path, preserving a leading slash and a trailing slash. */
export function normalize(input) {
  const absolute = input.startsWith(sep);
  const trailing = input.length > 1 && input.endsWith(sep);
  const segments = [];

  for (const segment of input.split(sep)) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      }
      continue;
    }

    segments.push(segment);
  }

  let result = segments.join(sep);
  if (absolute) result = `${sep}${result}`;
  if (result === "") result = absolute ? sep : ".";
  else if (trailing && result !== sep) result += sep;

  return result;
}

/** Join path segments. Absolute later segments do not reset the result. */
export function join(...parts) {
  const joined = parts.filter((part) => part !== "" && part !== undefined)
    .join(sep);
  return joined === "" ? "." : normalize(joined);
}

/** Resolve path segments to an absolute path, like Node's `path.resolve`. */
export function resolve(...parts) {
  let resolved = "";
  let absolute = false;

  for (let index = parts.length - 1; index >= -1; index -= 1) {
    const part = index >= 0 ? parts[index] : Deno.cwd();
    if (part === undefined || part === "") continue;

    resolved = `${part}${sep}${resolved}`;
    if (part.startsWith(sep)) {
      absolute = true;
      break;
    }
  }

  const normalised = normalize(resolved);
  const result = absolute
    ? normalised
    : normalize(`${Deno.cwd()}${sep}${normalised}`);

  return result.length > 1 && result.endsWith(sep)
    ? result.slice(0, -1)
    : result;
}

/** Relative path from `from` to `to`, like Node's `path.relative`. */
export function relative(from, to) {
  const fromParts = resolve(from).split(sep).filter(Boolean);
  const toParts = resolve(to).split(sep).filter(Boolean);

  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }

  return [
    ...Array.from({ length: fromParts.length - common }, () => ".."),
    ...toParts.slice(common),
  ].join(sep);
}

/** Directory portion of a path, like Node's lexically operating dirname. */
export function dirname(input) {
  if (input === "") return ".";

  const hasRoot = input.startsWith(sep);
  let end = -1;
  let matchedSlash = true;

  for (let index = input.length - 1; index >= 1; index -= 1) {
    if (input[index] === sep) {
      if (!matchedSlash) {
        end = index;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }

  if (end === -1) return hasRoot ? sep : ".";
  if (hasRoot && end === 1) return `${sep}${sep}`;
  return input.slice(0, end);
}

/** Final portion of a path, like Node's lexically operating basename. */
export function basename(input) {
  if (input === "") return "";

  let end = input.length;
  while (end > 1 && input[end - 1] === sep) end -= 1;

  const trimmed = input.slice(0, end);
  const index = trimmed.lastIndexOf(sep);
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** Extension including the dot, like Node's `path.extname`. */
export function extname(input) {
  const base = basename(input);
  if (base === "" || base === "." || base === "..") return "";

  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index);
}

/** True when the path is absolute in the POSIX sense. */
export function isAbsolute(input) {
  return typeof input === "string" && input.startsWith(sep);
}

/** Convert a file: URL to a decoded local filesystem path. */
export function fromFileUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") {
    throw new TypeError(`not a file URL: ${String(url)}`);
  }

  return decodeURIComponent(parsed.pathname);
}

export default {
  basename,
  dirname,
  extname,
  fromFileUrl,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
};
