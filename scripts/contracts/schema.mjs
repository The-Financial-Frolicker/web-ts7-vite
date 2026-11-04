/**
 * Shape validation for the approved contract document.
 *
 * The document is a reviewed engineering artefact, so validation is strict:
 * unknown provenance values, an unapproved contract or an `unverified` value in
 * a mandatory slot are all errors rather than warnings. CI must fail closed on
 * a contract it cannot understand.
 */

/**
 * The approval lifecycle of a single contract.
 *
 *   candidate  produced by discovery; not reviewable by CI
 *   bootstrap  a provisional development baseline carried over without a
 *              human decision; not reviewable by CI, and never records an
 *              approver because there was none
 *   approved   an explicit human decision, bound to this exact fingerprint
 *
 * The smallest model that keeps "no human has decided yet" from being
 * indistinguishable from "a human decided".
 */
export const CONTRACT_STATES = Object.freeze([
  "candidate",
  "bootstrap",
  "approved",
]);

/** True when the contract carries a valid human approval for its fingerprint. */
export function isApproved(contract) {
  return contract.state === "approved" &&
    contract.approved !== null &&
    contract.approved.fingerprint === contract.fingerprint;
}

export const SCHEMA_VERSION = 1;

export const PROVENANCE = Object.freeze([
  /** Read from an authoritative source (project configuration, lockfile). */
  "authoritative",
  /** Measured in this environment (a probe that produced evidence). */
  "observed",
  /** Computed from other contract values, with the rule stated in evidence. */
  "derived",
  /** A human decision. Never inferred, never widened automatically. */
  "declared",
  /** Evidence is missing or the probe failed; the contract cannot be approved. */
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

/** Validate one scoped contract; returns the parsed fingerprint inputs. */
export function validateContract(key, contract) {
  requireObject(contract, `contract ${JSON.stringify(key)}`);
  requireString(contract.scope, `contract ${key} scope`);
  requireString(contract.fingerprint, `contract ${key} fingerprint`);
  requireObject(
    contract.fingerprintInputs,
    `contract ${key} fingerprintInputs`,
  );
  requireObject(contract.values, `contract ${key} values`);

  if (Object.keys(contract.fingerprintInputs).length === 0) {
    fail(`contract ${key} has empty fingerprintInputs`);
  }
  if (Object.keys(contract.values).length === 0) {
    fail(`contract ${key} has no values`);
  }

  for (const [valueKey, entry] of Object.entries(contract.values)) {
    validateValue(valueKey, entry, `contract ${key}`);
  }

  if (!CONTRACT_STATES.includes(contract.state)) {
    fail(
      `contract ${key} has state ${JSON.stringify(contract.state)}; ` +
        `expected one of ${CONTRACT_STATES.join(", ")}`,
    );
  }

  if (contract.state === "approved") {
    requireObject(contract.approved, `contract ${key} approved`);
    requireString(contract.approved.by, `contract ${key} approved.by`);
    requireString(contract.approved.at, `contract ${key} approved.at`);
    requireString(contract.approved.reason, `contract ${key} approved.reason`);
    requireString(
      contract.approved.fingerprint,
      `contract ${key} approved.fingerprint`,
    );
    if (contract.approved.fingerprint !== contract.fingerprint) {
      fail(
        `contract ${key} is approved for fingerprint ` +
          `${contract.approved.fingerprint}, but its own fingerprint is ` +
          `${contract.fingerprint}; an approval is bound to one fingerprint`,
      );
    }
    if (contract.bootstrap != null) {
      fail(`contract ${key} cannot be both approved and bootstrap`);
    }
  } else {
    if (contract.approved != null) {
      fail(
        `contract ${key} is ${contract.state} but carries an approval record; ` +
          `only an explicit approval may record an approver`,
      );
    }
    if (contract.state === "bootstrap") {
      requireObject(contract.bootstrap, `contract ${key} bootstrap`);
      requireString(contract.bootstrap.at, `contract ${key} bootstrap.at`);
      requireString(
        contract.bootstrap.reason,
        `contract ${key} bootstrap.reason`,
      );
    } else if (contract.bootstrap != null) {
      fail(`contract ${key} is a candidate but carries bootstrap metadata`);
    }
  }

  return contract;
}

/** Values whose provenance makes a contract unapprovable. */
export function unverifiedValues(contract) {
  return Object.entries(contract.values)
    .filter(([, entry]) => entry.provenance === "unverified")
    .map(([key]) => key);
}

/** Validate a whole document. Throws `ContractError` on the first problem. */
export function validateDocument(document) {
  requireObject(document, "contract document");

  if (document.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `contract document schemaVersion is ${
        JSON.stringify(document.schemaVersion)
      }; ` +
        `this tool reads version ${SCHEMA_VERSION}`,
    );
  }

  requireObject(document.toolchain, "contract document toolchain");
  requireObject(document.contracts, "contract document contracts");
  requireObject(document.policies, "contract document policies");

  for (const [key, contract] of Object.entries(document.contracts)) {
    validateContract(key, contract);
  }

  for (const [name, policy] of Object.entries(document.policies)) {
    requireObject(policy, `policy ${name}`);
    if (policy.provenance !== "declared") {
      fail(
        `policy ${name} must have provenance "declared"; ` +
          `discovery must never infer or widen a policy`,
      );
    }
    requireString(policy.rationale, `policy ${name} rationale`);
    requireString(policy.decidedBy, `policy ${name} decidedBy`);
    requireString(policy.decidedAt, `policy ${name} decidedAt`);
    if (!Array.isArray(policy.reviewedAgainst)) {
      fail(`policy ${name} reviewedAgainst must be an array`);
    }
    if (!Array.isArray(policy.checkedAgainst)) {
      fail(`policy ${name} checkedAgainst must be an array`);
    }
  }

  return document;
}

/** Keys of contracts that do not carry a valid human approval. */
export function unapprovedContracts(document) {
  return Object.entries(document.contracts)
    .filter(([, contract]) => !isApproved(contract))
    .map(([key]) => key);
}
