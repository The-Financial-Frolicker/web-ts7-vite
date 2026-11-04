/**
 * Reading and writing the contract artefact.
 *
 * The approved document is committed; the candidate produced by discovery is
 * not. Nothing here can approve anything: `approve.mjs` owns that decision and
 * records who made it.
 */

import { readFileSync } from "../lib/fs.mjs";
import path from "../lib/path.mjs";
import { canonicalJson } from "./canonical.mjs";
import { ContractError, isApproved, validateDocument } from "./schema.mjs";

export const CONTRACT_FILE = "toolchain-contracts.json";
export const CANDIDATE_FILE = path.join(".contracts", "candidate.json");

function fail(message) {
  throw new ContractError(message);
}

/** Load and validate a contract document. */
export function loadDocument(root, file = CONTRACT_FILE) {
  let text;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    fail(
      `no contract document at ${file}. Run the local discovery and approval ` +
        `cycle: deno task contract:discover && deno task contract:approve`,
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

/** True when a contract document exists at `file`. */
export function documentExists(root, file = CONTRACT_FILE) {
  try {
    Deno.statSync(path.join(root, file));
    return true;
  } catch {
    return false;
  }
}

/** Validate, canonicalise and write a document. */
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
 * Add the candidate's contracts to the approved document, preserving history.
 *
 * Existing approved contracts are never replaced implicitly. `replace` is the
 * explicit opt-in used when re-approving the same fingerprint; a new
 * fingerprint is simply added alongside its predecessors.
 */
export function mergeContracts(existing, candidate) {
  return {
    ...existing,
    schemaVersion: candidate.schemaVersion,
    toolchain: candidate.toolchain,
    contracts: {
      ...existing.contracts,
      ...candidate.contracts,
    },
  };
}

/** Stable, human-readable summary of a document. */
export function summarise(document) {
  return Object.entries(document.contracts).map(([key, contract]) => ({
    key,
    scope: contract.scope,
    state: contract.state,
    approved: isApproved(contract),
    values: Object.keys(contract.values).length,
  }));
}
