/** Minimal OS helpers for the Deno-native test tooling. */

/** Temporary directory, matching Node's `os.tmpdir()` resolution order. */
export function tmpdir() {
  return Deno.env.get("TMPDIR") ?? Deno.env.get("TMP") ??
    Deno.env.get("TEMP") ?? "/tmp";
}

export default { tmpdir };
