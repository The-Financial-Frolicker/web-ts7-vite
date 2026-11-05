/**
 * Shape validation for the v2 contract lock.
 *
 * The lock records mechanically derived facts about the authorised
 * configuration and the installed toolchain. It records no lifecycle state and
 * no approval: nothing in it is a human decision, so there is nothing for a
 * human to certify here. The source configuration is the specification; the
 * lock is what the machine derived from it.
 *
 * Validation is strict and fails closed: an unknown field, a v1 lifecycle
 * field, a fingerprint that does not match its key, or an `unverified` value is
 * an error rather than a warning.
 */

import { contractKey } from "./canonical.mjs";
import { SCOPES } from "./scopes.mjs";

export const SCHEMA_VERSION = 2;

/**
 * Per-run conformance status of one scope.
 *
 * These are computed by verification and never stored: `recorded` means the
 * current derivation matches the committed lock, `drifted` means a contract
 * exists for the scope but describes different facts, and `unrecorded` means the
 * lock has no contract for that scope at all.
 */
export const CONTRACT_STATUSES = Object.freeze([
  "recorded",
  "drifted",
  "unrecorded",
]);

/**
 * How a recorded value was established.
 *
 * There is deliberately no "declared": a value no derivation supports does not
 * belong in a lock. Human decisions belong in the source configuration the lock
 * is derived from.
 */
export const PROVENANCE = Object.freeze([
  /** Read from the project's own configuration or installed package manifests. */
  "authoritative",
  /** Measured by a probe in the authoring environment. */
  "observed",
  /** Computed from other values by a rule stated in the evidence. */
  "derived",
  /** Evidence is missing or a probe failed; conformance cannot be established. */
  "unverified",
]);

export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

function fail(message) {
  throw new ContractError(message);
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

const DOCUMENT_FIELDS = new Set(["schemaVersion", "toolchain", "contracts"]);
const CONTRACT_FIELDS = new Set([
  "scope",
  "fingerprint",
  "fingerprintInputs",
  "values",
]);

/** v1 fields, named so the migration error explains itself. */
const OBSOLETE_DOCUMENT_FIELDS = new Set(["policies"]);
const OBSOLETE_CONTRACT_FIELDS = new Set(["state", "approved", "bootstrap"]);

function rejectUnknownFields(object, allowed, obsolete, label) {
  for (const key of Object.keys(object)) {
    if (allowed.has(key)) continue;
    if (obsolete.has(key)) {
      fail(
        `${label} declares ${JSON.stringify(key)}, which is v1 lifecycle ` +
          `metadata; a v2 lock records derived facts only`,
      );
    }
    fail(`${label} has unknown field ${JSON.stringify(key)}`);
  }
}

/** Validate one keyed value entry and return it. */
export function validateValue(key, entry, contractKeyLabel) {
  const label = `${contractKeyLabel} value ${JSON.stringify(key)}`;
  requireObject(entry, label);
  requireString(entry.kind, `${label} kind`);

  if (!PROVENANCE.includes(entry.provenance)) {
    fail(
      `${label} has provenance ${JSON.stringify(entry.provenance)}; ` +
        `expected one of ${PROVENANCE.join(", ")}`,
    );
  }

  if (entry.value === undefined) fail(`${label} has no value`);
  requireString(entry.evidence, `${label} evidence`);

  return entry;
}

/** Validate one scoped contract; returns it. */
export function validateContract(key, contract) {
  requireObject(contract, `contract ${JSON.stringify(key)}`);
  rejectUnknownFields(
    contract,
    CONTRACT_FIELDS,
    OBSOLETE_CONTRACT_FIELDS,
    `contract ${key}`,
  );

  const scope = requireString(contract.scope, `contract ${key} scope`);
  if (!SCOPES.includes(scope)) {
    fail(
      `contract ${key} has unknown scope ${JSON.stringify(scope)}; expected ` +
        `one of ${SCOPES.join(", ")}`,
    );
  }

  const fingerprint = requireString(
    contract.fingerprint,
    `contract ${key} fingerprint`,
  );
  if (!/^sha256:[0-9a-f]{64}$/.test(fingerprint)) {
    fail(
      `contract ${key} fingerprint is ${JSON.stringify(fingerprint)}; ` +
        `expected sha256:<64 hex characters>`,
    );
  }
  if (contractKey(scope, fingerprint) !== key) {
    fail(
      `contract key ${JSON.stringify(key)} does not match its scope and ` +
        `fingerprint (${contractKey(scope, fingerprint)})`,
    );
  }

  requireObject(
    contract.fingerprintInputs,
    `contract ${key} fingerprintInputs`,
  );
  requireObject(contract.values, `contract ${key} values`);
  for (const [valueKey, entry] of Object.entries(contract.values)) {
    validateValue(valueKey, entry, `contract ${key}`);
  }

  return contract;
}

/** Values whose provenance makes the contract unconformant. */
export function unverifiedValues(contract) {
  return Object.entries(contract.values)
    .filter(([, entry]) => entry.provenance === "unverified")
    .map(([key]) => key);
}

/** Validate a whole lock document. Throws `ContractError` on the first problem. */
export function validateDocument(document) {
  requireObject(document, "contract lock");

  if (document.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `contract lock schemaVersion is ${
        JSON.stringify(document.schemaVersion)
      }; this tool reads version ${SCHEMA_VERSION}. A v1 document is not ` +
        `readable: run \`deno task contract:refresh\` and commit the result.`,
    );
  }

  rejectUnknownFields(
    document,
    DOCUMENT_FIELDS,
    OBSOLETE_DOCUMENT_FIELDS,
    "contract lock",
  );

  requireObject(document.toolchain, "contract lock toolchain");
  requireObject(document.contracts, "contract lock contracts");

  const seen = new Set();
  for (const [key, contract] of Object.entries(document.contracts)) {
    validateContract(key, contract);
    if (seen.has(contract.scope)) {
      fail(
        `contract lock records scope ${JSON.stringify(contract.scope)} more ` +
          `than once; one scope has one contract`,
      );
    }
    seen.add(contract.scope);
  }

  return document;
}
