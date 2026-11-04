/**
 * Canonical serialisation and fingerprinting for toolchain contracts.
 *
 * Two properties matter and both are deliberately boring:
 *
 *   1. The same logical value always serialises to the same bytes, so a
 *      contract reviewed on one machine is byte-identical to the one CI reads.
 *      Object keys are sorted; array order is preserved because order is
 *      meaningful (compatibility flags, browser target lists).
 *   2. A fingerprint is a pure function of a small identity object, never of
 *      file timestamps, absolute paths or the order in which discovery ran.
 */

/** Serialise a JSON value with object keys sorted at every depth. */
export function canonicalJson(value, space = 2) {
  return JSON.stringify(sortValue(value), null, space);
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) continue;
    sorted[key] = sortValue(entry);
  }

  return sorted;
}

/** SHA-256 of the canonical form, hex encoded with an algorithm prefix. */
export async function fingerprintOf(input) {
  const bytes = new TextEncoder().encode(canonicalJson(input, 0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

/** Stable dictionary key for one scoped contract. */
export function contractKey(scope, fingerprint) {
  return `${scope}@${fingerprint}`;
}
