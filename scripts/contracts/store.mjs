/**
 * Reading and writing the contract lock.
 *
 * `contract:refresh` is the only operation that writes the lock. Verification
 * loads it, compares it and reports; it has no write path, and its launcher runs
 * without write permission, so a conformance failure can never repair itself by
 * rewriting the record it is checked against.
 */

import { readFileSync } from "../lib/fs.mjs";
import path from "../lib/path.mjs";
import { canonicalJson, fingerprintOf } from "./canonical.mjs";
import { ContractError, validateDocument } from "./schema.mjs";

export const CONTRACT_FILE = "toolchain-contracts.json";

function fail(message) {
  throw new ContractError(message);
}

/** Load and validate the committed lock. */
export function loadDocument(root, file = CONTRACT_FILE) {
  let text;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    fail(
      `no contract lock at ${file}. Derive it on the authorised platform with ` +
        `\`deno task contract:refresh\` and commit the result`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`${file} is not valid JSON: ${error.message}`);
  }

  return validateDocument(parsed);
}

/** True when a lock exists at `file`. */
export function documentExists(root, file = CONTRACT_FILE) {
  try {
    Deno.statSync(path.join(root, file));
    return true;
  } catch {
    return false;
  }
}

/** Validate, canonicalise and write a lock. Refresh is the only caller. */
export function writeDocument(root, document, file = CONTRACT_FILE) {
  validateDocument(document);
  const target = path.join(root, file);
  const directory = path.dirname(target);

  // Creating a directory that already exists would demand write access to its
  // parent, which is a broader grant than writing the file itself.
  try {
    Deno.statSync(directory);
  } catch {
    Deno.mkdirSync(directory, { recursive: true });
  }

  Deno.writeTextFileSync(target, `${canonicalJson(document)}\n`);
  return target;
}

/**
 * Digest of the whole lock.
 *
 * Per-run reports and evidence cross-reference this value instead of a path or a
 * timestamp, so two runs against the same lock are comparable.
 */
export function lockDigest(document) {
  return fingerprintOf(document);
}

/** Stable summary of a lock: one entry per recorded scope. */
export function summarise(document) {
  return Object.entries(document.contracts).map(([key, contract]) => ({
    key,
    scope: contract.scope,
    fingerprint: contract.fingerprint,
    values: Object.keys(contract.values).length,
  }));
}
