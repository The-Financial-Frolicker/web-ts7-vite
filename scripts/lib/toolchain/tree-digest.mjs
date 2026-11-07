/**
 * Deterministic digest of a materialised dependency tree.
 *
 * Covers what the tree *is*: relative path, entry kind, permission bits, byte
 * size, content hash and symlink target. Timestamps are deliberately excluded,
 * so the same tree always yields the same digest and any content, mode or link
 * change yields a different one.
 *
 * Used to record the materialisation identity of the toolchain installation and
 * to prove that application workflows leave that tree untouched.
 */

const encoder = new TextEncoder();

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashFile(path) {
  return hex(await crypto.subtle.digest("SHA-256", Deno.readFileSync(path)));
}

function childNames(dir) {
  const names = [];
  for (const entry of Deno.readDirSync(dir)) names.push(entry.name);
  // Code-unit order: locale-independent, so every host agrees.
  return names.sort();
}

/**
 * Digest one tree.
 *
 * Returns `{ digest, files, dirs, symlinks, bytes, entries }`; `digest` is the
 * SHA-256 of the canonical listing.
 *
 * Also returns three *diagnostic* views of the same canonical entry data, so two
 * installations that agree on specification and resolution but disagree on the
 * materialisation digest can be compared without dumping thousands of paths:
 *
 *   `modeDigest` — SHA-256 over the sorted mode column. Only entries that carry
 *     a mode in the canonical model contribute (regular files `F` and
 *     directories `D`); symlinks and other entries have no mode and add nothing.
 *     Modes are the four octal digits exactly as written in the listing, sorted
 *     by code unit and joined with a newline.
 *   `pathDigest` — SHA-256 over every entry's relative path (`F`, `D`, `L`, `O`),
 *     sorted by code unit and joined with NUL. NUL cannot occur in a path, so
 *     the encoding is unambiguous even for names containing newlines.
 *   `pathModeDigest` — SHA-256 over the *path-to-mode binding*, so modes that are
 *     merely redistributed between paths are visible. It covers the same entries
 *     as `modeDigest` (regular files and directories), sorted by relative path in
 *     code-unit order, one record per entry encoded as `path NUL mode NUL`.
 *     Because NUL cannot occur in a path and a mode is always four octal digits,
 *     a NUL-terminated triple is unambiguous even for paths containing newlines;
 *     no separator can collide with data. Symlinks and other entries carry no
 *     mode and contribute nothing.
 *
 * Reading the three together (counters remain useful corroboration):
 *
 *   path column differs                             -> entry paths differ
 *   path equal, mode column differs                 -> overall mode distribution differs
 *   path and mode equal, path-mode column differs   -> modes moved between paths
 *   all three equal, `digest` differs               -> contents, symlink targets or
 *                                                      another canonical-entry difference
 *   all equal                                       -> the materialisation identity matches
 *
 * These are diagnostics: they are not part of the materialisation identity and
 * never feed `digest`.
 */
export async function treeDigest(root) {
  const lines = [];
  const paths = [];
  const modes = [];
  const pathModes = [];
  let files = 0;
  let dirs = 0;
  let symlinks = 0;
  let other = 0;
  let bytes = 0;

  async function walk(dir, relative) {
    for (const name of childNames(dir)) {
      const absolute = `${dir}/${name}`;
      const path = relative.length === 0 ? name : `${relative}/${name}`;
      const stat = Deno.lstatSync(absolute);
      const mode = ((stat.mode ?? 0) & 0o7777).toString(8).padStart(4, "0");
      paths.push(path);

      if (stat.isSymlink) {
        symlinks += 1;
        lines.push(`L ${path} -> ${Deno.readLinkSync(absolute)}`);
      } else if (stat.isDirectory) {
        dirs += 1;
        modes.push(mode);
        pathModes.push([path, mode]);
        lines.push(`D ${mode} ${path}`);
        await walk(absolute, path);
      } else if (stat.isFile) {
        files += 1;
        bytes += stat.size;
        modes.push(mode);
        pathModes.push([path, mode]);
        lines.push(
          `F ${mode} ${stat.size} ${await hashFile(absolute)} ${path}`,
        );
      } else {
        other += 1;
        lines.push(`O ${path}`);
      }
    }
  }

  await walk(root, "");

  const digestOf = async (text) =>
    hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

  // Sort by relative path in code-unit order, then emit `path NUL mode NUL` per
  // record. NUL cannot occur in a path and a mode is always four octal digits,
  // so the triple is unambiguous even for paths containing newlines.
  const pathModeColumn = pathModes
    .slice()
    .sort((
      left,
      right,
    ) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([path, mode]) => `${path}\0${mode}\0`)
    .join("");

  return {
    digest: await digestOf(lines.join("\n")),
    files,
    dirs,
    symlinks,
    other,
    bytes,
    entries: lines.length,
    modeDigest: await digestOf([...modes].sort().join("\n")),
    pathDigest: await digestOf([...paths].sort().join("\0")),
    pathModeDigest: await digestOf(pathModeColumn),
  };
}

/** Digest of one file, for specification and resolution identities. */
export async function fileDigest(path) {
  return hex(await crypto.subtle.digest("SHA-256", Deno.readFileSync(path)));
}

/** Digest of an ordered list of `{ name, digest }` pairs. */
export async function digestOfFiles(entries) {
  const canonical = entries.map((entry) => `${entry.name} ${entry.digest}`)
    .join("\n");
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonical)));
}
