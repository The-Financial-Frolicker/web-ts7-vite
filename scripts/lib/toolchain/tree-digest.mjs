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
 * Recognise Deno installer metadata (G8/G8a). Returns the rule id or null.
 *
 * Every rule is anchored to a Deno-owned location; none is a global basename
 * exclusion. Evidence: `deno` v2.9.8 `libs/npm_installer/local.rs` and
 * `global.rs` (see the G8/G8a reports).
 *
 *   M1  .deno/.deno.lock            lock-file target for node_modules         (local.rs)
 *   M2  .deno/.setup-cache.bin      bincode setup/cleanup decision cache      (local.rs)
 *   M3  .deno/<entry>/.initialized  per-store-entry setup marker              (local.rs)
 *   M4  .deno/<entry>/.scripts-warned  lifecycle-warning record               (local.rs)
 *   M5  .deno/<entry>/node_modules/<pkg…>/.scripts-warned-<digits>
 *       Zero-byte warning record whose name embeds an XxHash64 of the
 *       installer's root_dir, so the name is machine-derived by construction
 *       (global.rs). Requires the store path, the exact name and zero length;
 *       a non-empty file of the same name stays implementation.
 */
/** Human-readable kind for an unexpected entry, used by the fail-closed error. */
function entryKind(stat) {
  if (stat.isFifo) return "fifo";
  if (stat.isSocket) return "socket";
  if (stat.isBlockDevice) return "block device";
  if (stat.isCharDevice) return "character device";
  return "unknown";
}

export function metadataRule(path, kind, size) {
  const parts = path.split("/");

  if (parts.length === 2 && parts[0] === ".deno") {
    if (parts[1] === ".deno.lock") return "M1";
    if (parts[1] === ".setup-cache.bin") return "M2";
  }

  if (parts.length === 3 && parts[0] === ".deno") {
    if (parts[2] === ".initialized") return "M3";
    if (parts[2] === ".scripts-warned") return "M4";
  }

  if (
    kind === "file" &&
    size === 0 &&
    parts.length >= 5 &&
    parts[0] === ".deno" &&
    parts[2] === "node_modules" &&
    /^\.scripts-warned-[0-9]+$/.test(parts[parts.length - 1])
  ) {
    return "M5";
  }

  return null;
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
  const implemented = [];
  const metadata = [];
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
      // Owner triad only (`0o700`), so setuid/setgid/sticky and the group/other
      // bits cannot enter the identity. The toolchain is installed and executed
      // by one user; those bits are umask noise, not execution meaning.
      const owner = (((stat.mode ?? 0) & 0o700) >> 6).toString(8);
      paths.push(path);

      if (stat.isSymlink) {
        symlinks += 1;
        const target = Deno.readLinkSync(absolute);
        lines.push(`L ${path} -> ${target}`);
        implemented.push([path, `L\0${path}\0${target}\0`]);
      } else if (stat.isDirectory) {
        dirs += 1;
        modes.push(mode);
        pathModes.push([path, mode]);
        lines.push(`D ${mode} ${path}`);
        const rule = metadataRule(path, "directory", 0);
        if (rule === null) {
          implemented.push([path, `D\0${owner}\0${path}\0`]);
        } else {
          metadata.push([
            path,
            `M\0${rule}\0directory\0-\0${mode}\0-\0${path}\0`,
          ]);
        }
        await walk(absolute, path);
      } else if (stat.isFile) {
        files += 1;
        bytes += stat.size;
        modes.push(mode);
        pathModes.push([path, mode]);
        const content = await hashFile(absolute);
        lines.push(`F ${mode} ${stat.size} ${content} ${path}`);
        const rule = metadataRule(path, "file", stat.size);
        if (rule === null) {
          implemented.push([
            path,
            `F\0${owner}\0${stat.size}\0${content}\0${path}\0`,
          ]);
        } else {
          metadata.push([
            path,
            `M\0${rule}\0file\0${stat.size}\0${mode}\0${content}\0${path}\0`,
          ]);
        }
      } else {
        // Fail closed: an entry type outside {file, directory, symlink} has no
        // established identity semantics, so the identity is refused rather
        // than being silently approximated.
        other += 1;
        throw new Error(
          `unsupported filesystem entry ${entryKind(stat)} at ${
            JSON.stringify(path)
          }; ` +
            `the dependency implementation identity only covers files, ` +
            `directories and symlinks`,
        );
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
    // Cross-machine layer: the installed implementation, without installer
    // state. Records are `path NUL field… NUL`; NUL cannot occur in a path, so
    // the encoding is unambiguous even for names containing newlines.
    implementationDigest: await digestOf(
      implemented
        .slice()
        .sort((left, right) =>
          left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
        )
        .map(([, record]) => record)
        .join(""),
    ),
    implementationEntries: implemented.length,
    // Installer state: excluded from the identity above, reported here so a
    // difference between machines stays visible instead of silent.
    metadataFiles: metadata.length,
    metadataDigest: await digestOf(
      metadata
        .slice()
        .sort((left, right) =>
          left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
        )
        .map(([, record]) => record)
        .join(""),
    ),
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
