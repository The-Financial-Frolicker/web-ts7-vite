/**
 * Deno-native replacements for the small Node `fs` surface used by the
 * project tooling.
 *
 * The signatures intentionally resemble the Node functions they replace so the
 * migration stays reviewable. Differences that matter to callers are handled
 * here: Deno reports file kinds as properties, while Node exposes methods, and
 * Deno has no `force` option for removal.
 */

import path from "./path.mjs";

const decoder = new TextDecoder();

function fileInfo(info) {
  return {
    ...info,
    mode: info.mode ?? 0,
    isFile: () => info.isFile,
    isDirectory: () => info.isDirectory,
    isSymbolicLink: () => info.isSymlink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

/** Read a file as text when requested, otherwise as bytes. */
export function readFileSync(file, options) {
  const bytes = Deno.readFileSync(file);
  if (options === "utf8" || options?.encoding === "utf8") {
    return decoder.decode(bytes);
  }

  return bytes;
}

/** Write text or bytes, honouring the Node `flag: "wx"` create-new mode. */
export function writeFileSync(file, data, options = {}) {
  const writeOptions = {
    createNew: options.flag === "wx",
    mode: options.mode,
  };

  if (typeof data === "string") {
    Deno.writeTextFileSync(file, data, writeOptions);
  } else {
    Deno.writeFileSync(file, data, writeOptions);
  }
}

/** Create a directory, optionally recursively. */
export function mkdirSync(directory, options = {}) {
  Deno.mkdirSync(directory, {
    recursive: options.recursive === true,
    mode: options.mode,
  });
}

/** Remove a file, link or tree; `force` ignores a missing path. */
export function rmSync(target, options = {}) {
  try {
    Deno.removeSync(target, { recursive: options.recursive === true });
  } catch (error) {
    if (options.force === true && error instanceof Deno.errors.NotFound) {
      return;
    }
    throw error;
  }
}

/** Create a unique temporary directory from a Node-style full-path prefix. */
export function mkdtempSync(prefix) {
  const directory = path.dirname(prefix);
  const base = path.basename(prefix);

  return Deno.makeTempDirSync({
    dir: directory === "." ? undefined : directory,
    prefix: base === "" ? "tmp-" : base,
  });
}

/** Stat a path, following symbolic links. */
export function statSync(file) {
  return fileInfo(Deno.statSync(file));
}

/** Stat a path without following the final symbolic link. */
export function lstatSync(file) {
  return fileInfo(Deno.lstatSync(file));
}

/** Read a directory, returning names or Node-shaped directory entries. */
export function readdirSync(directory, options = {}) {
  const entries = [...Deno.readDirSync(directory)];

  if (options.withFileTypes !== true) {
    return entries.map((entry) => entry.name);
  }

  return entries.map((entry) => ({
    name: entry.name,
    isFile: () => entry.isFile,
    isDirectory: () => entry.isDirectory,
    isSymbolicLink: () => entry.isSymlink,
  }));
}

/** Resolve every symbolic link in a path. */
export function realpathSync(file) {
  return Deno.realPathSync(file);
}

/** Rename or move a path. */
export function renameSync(from, to) {
  Deno.renameSync(from, to);
}

/** Change a path's mode bits. */
export function chmodSync(file, mode) {
  Deno.chmodSync(file, mode);
}

/** Remove a file or symbolic link. */
export function unlinkSync(file) {
  Deno.removeSync(file);
}

/** Create a symbolic link; the Node `type` argument is accepted for parity. */
export function symlinkSync(target, link, type) {
  Deno.symlinkSync(target, link, type === undefined ? undefined : { type });
}

/** True when lstat succeeds for the path. */
export function existsSync(file) {
  try {
    Deno.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}
