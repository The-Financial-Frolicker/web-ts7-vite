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
 */
export async function treeDigest(root) {
  const lines = [];
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

      if (stat.isSymlink) {
        symlinks += 1;
        lines.push(`L ${path} -> ${Deno.readLinkSync(absolute)}`);
      } else if (stat.isDirectory) {
        dirs += 1;
        lines.push(`D ${mode} ${path}`);
        await walk(absolute, path);
      } else if (stat.isFile) {
        files += 1;
        bytes += stat.size;
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

  return {
    digest: hex(
      await crypto.subtle.digest("SHA-256", encoder.encode(lines.join("\n"))),
    ),
    files,
    dirs,
    symlinks,
    other,
    bytes,
    entries: lines.length,
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
