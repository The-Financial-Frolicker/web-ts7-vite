/**
 * Read-only conformance verification.
 *
 * Verification recomputes the contract facts from the authorised source and the
 * installed toolchain, compares them with the committed lock, and reports the
 * result. Every input is a file read or an in-memory comparison: this module
 * never spawns workerd, Vite or any other tool, so CI cannot create evidence —
 * it can only establish whether the environment still conforms.
 *
 * Consequences that matter:
 *   - a mismatch is a failure; verification never refreshes the lock;
 *   - values that can only be measured are recorded by refresh and are not
 *     re-measured here, so the fingerprints of their inputs carry the check;
 *   - a per-run report is produced even when verification fails.
 */

import { readFileSync } from "../lib/fs.mjs";
import path from "../lib/path.mjs";
import { canonicalJson, contractKey, fingerprintOf } from "./canonical.mjs";
import { CLIENT_TSCONFIG, WORKER_TSCONFIG } from "./config.mjs";
import { contractInputs, currentIdentity } from "./identity.mjs";
import {
  fingerprintInputs,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_WORKERD_RUNTIME,
  SCOPES,
} from "./scopes.mjs";
import { SCHEMA_VERSION, unverifiedValues } from "./schema.mjs";
import { loadDocument, lockDigest } from "./store.mjs";

export const DEPLOY_CONFIG = path.join("dist", "worker", "wrangler.json");

/** Normalise a TypeScript `lib` entry (`ES2023`) to an edition id (`es2023`). */
export function editionId(lib) {
  return String(lib).toLowerCase();
}

/** Highest ES edition in a `lib` list, or null when none is declared. */
export function declaredEdition(libs) {
  const editions = libs.map(editionId).filter((id) =>
    /^es[0-9]+$|^esnext$/.test(id)
  );
  if (editions.length === 0) return null;
  return editions.sort((a, b) => rank(a) - rank(b)).at(-1);
}

function rank(id) {
  return id === "esnext" ? Number.MAX_SAFE_INTEGER : Number(id.slice(2));
}

function compare(actual, expected) {
  // Key order is not meaningful in JSON; compare the canonical form so a lock
  // round-tripped through disk never "differs" by ordering alone.
  return canonicalJson(actual, 0) === canonicalJson(expected, 0);
}

/** Name the fingerprint inputs that differ, for a drift that needs explaining. */
export function inputDifferences(recorded, derived) {
  const names = new Set([
    ...Object.keys(recorded ?? {}),
    ...Object.keys(derived ?? {}),
  ]);

  return [...names].sort()
    .filter((name) => !compare(recorded?.[name], derived?.[name]))
    .map((name) => ({
      name,
      recorded: recorded?.[name] ?? null,
      derived: derived?.[name] ?? null,
    }));
}

/**
 * Build the per-run conformance report from a lock and a fresh derivation.
 *
 * Pure with respect to the filesystem: the caller supplies the document and the
 * identity, so this can be exercised on fixtures and cannot write anything.
 */
export async function buildConformanceReport({
  document,
  identity,
  digest = null,
}) {
  const inputs = contractInputs(identity);
  const scopes = [];
  const problems = [];

  for (const scope of SCOPES) {
    const derivedInputs = fingerprintInputs(scope, inputs);
    const derivedFingerprint = await fingerprintOf(derivedInputs);
    const derivedKey = contractKey(scope, derivedFingerprint);

    const exact = document.contracts[derivedKey];
    if (exact !== undefined) {
      // The key matches, so the scope is recorded — unless the recorded inputs
      // do not match the fingerprint they are keyed by, which is what a
      // hand-edited or corrupted lock looks like. Fail closed on that too.
      const changed = inputDifferences(
        exact.fingerprintInputs,
        derivedInputs,
      );
      if (changed.length === 0) {
        scopes.push({
          scope,
          status: "recorded",
          recordedKey: derivedKey,
          recordedFingerprint: exact.fingerprint,
          derivedKey,
          derivedFingerprint,
          inputs: derivedInputs,
        });
        continue;
      }

      scopes.push({
        scope,
        status: "drifted",
        recordedKey: derivedKey,
        recordedFingerprint: exact.fingerprint,
        derivedKey,
        derivedFingerprint,
        inputs: derivedInputs,
        recordedInputs: exact.fingerprintInputs,
        changedInputs: changed,
      });
      problems.push(
        `scope ${scope} is internally inconsistent: the recorded inputs do ` +
          `not match the fingerprint they are keyed by (${
            changed.map((entry) => entry.name).join(", ")
          }). Run \`deno task contract:refresh\` and commit the result.`,
      );
      continue;
    }

    const recorded = Object.entries(document.contracts)
      .filter(([, contract]) => contract.scope === scope);

    if (recorded.length === 0) {
      scopes.push({
        scope,
        status: "unrecorded",
        recordedKey: null,
        recordedFingerprint: null,
        derivedKey,
        derivedFingerprint,
        inputs: derivedInputs,
      });
      problems.push(
        `scope ${scope} is unrecorded: the lock contains no contract for it. ` +
          `Run \`deno task contract:refresh\` on the authorised platform and ` +
          `commit the result.`,
      );
      continue;
    }

    const [recordedKey, contract] = recorded[0];
    scopes.push({
      scope,
      status: "drifted",
      recordedKey,
      recordedFingerprint: contract.fingerprint,
      derivedKey,
      derivedFingerprint,
      inputs: derivedInputs,
      recordedInputs: contract.fingerprintInputs,
      changedInputs: inputDifferences(
        contract.fingerprintInputs,
        derivedInputs,
      ),
    });
    problems.push(
      `scope ${scope} has drifted: the lock records ${contract.fingerprint}, ` +
        `the current configuration derives ${derivedFingerprint}. Inspect the ` +
        `changed inputs, then run \`deno task contract:refresh\` and review the ` +
        `resulting lock change.`,
    );
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    verdict: problems.length === 0 ? "conformant" : "drifted",
    lockDigest: digest,
    platform: identity.platform.key,
    scopes,
    problems,
  };
}

/** The recorded contract for a scope, when the scope conformed. */
function recordedContract(document, report, scope) {
  const entry = report.scopes.find((candidate) => candidate.scope === scope);
  if (entry === undefined || entry.status !== "recorded") return undefined;
  return document.contracts[entry.recordedKey];
}

/**
 * Enforce the interpreter the lock was authored with.
 *
 * Deno is deliberately *not* a conformance scope: it changes no recorded
 * compatibility fact, and a scope's key must be a function of the environment's
 * contract-relevant identity. It is recorded as provenance, and conformance
 * compares that record with the running interpreter — so adopting a different
 * Deno without recording it fails, while the distinction between "what was
 * recorded" and "what is verified" stays visible.
 */
export function denoProblems(document, running = Deno.version.deno) {
  const recorded = document?.toolchain?.deno?.version;

  if (typeof recorded !== "string" || recorded.length === 0) {
    return [
      "the lock records no Deno version; run `deno task contract:refresh` on " +
      "the authorised toolchain and commit the result",
    ];
  }

  if (recorded === running) return [];

  return [
    `the lock records Deno ${recorded}, but this process is Deno ${running}. ` +
    `Install the authorised toolchain (\`mise install\`), or run ` +
    `\`deno task contract:refresh\` and review the change if moving Deno is ` +
    `intended.`,
  ];
}

/**
 * Rules that compare recorded values with each other or with the build output.
 *
 * Fingerprint equality already proves the *inputs* still match; these checks
 * catch a lock that is internally inconsistent (for example a worker edition the
 * installed TypeScript does not ship) or a generated configuration that no
 * longer reflects the recorded one.
 */
export function ruleProblems(document, report, identity, root) {
  const problems = [];

  problems.push(...denoProblems(document));

  for (const entry of report.scopes) {
    if (entry.status !== "recorded") continue;
    const unverified = unverifiedValues(document.contracts[entry.recordedKey]);
    if (unverified.length > 0) {
      problems.push(
        `scope ${entry.scope} records unverified values: ${
          unverified.join(", ")
        }`,
      );
    }
  }

  const runtime = recordedContract(document, report, SCOPE_WORKERD_RUNTIME);
  const typescript = recordedContract(
    document,
    report,
    SCOPE_TYPESCRIPT_LIBRARIES,
  );

  const tsEditions = typescript?.values["typescript.editions"]?.value;
  const workerRecorded = runtime?.values["typescript.worker.libEdition"]?.value;

  if (runtime !== undefined) {
    const workerDeclared = declaredEdition(identity.typescript.workerLib);
    if (workerRecorded === undefined) {
      problems.push(
        "the workerd-runtime contract records no typescript.worker.libEdition",
      );
    } else if (workerDeclared !== workerRecorded) {
      problems.push(
        `${WORKER_TSCONFIG} declares ${
          workerDeclared ?? "no ES edition"
        }, but the lock records ${workerRecorded}`,
      );
    }
  }

  if (typescript !== undefined && !Array.isArray(tsEditions)) {
    problems.push(
      "the typescript-libraries contract records no typescript.editions",
    );
  }

  if (Array.isArray(tsEditions)) {
    if (
      typeof workerRecorded === "string" && !tsEditions.includes(workerRecorded)
    ) {
      problems.push(
        `the lock derives worker edition ${workerRecorded}, but the installed ` +
          `TypeScript does not provide it (${tsEditions.join(", ")})`,
      );
    }

    const clientDeclared = declaredEdition(identity.typescript.clientLib);
    problems.push(...clientEditionProblems(clientDeclared, tsEditions));
  }

  if (runtime !== undefined) {
    problems.push(...generatedConfigProblems(root, runtime));
  }

  return problems;
}

/** A declared client edition must exist in the compiler that is installed. */
export function clientEditionProblems(clientEdition, tsEditions) {
  if (
    clientEdition === null || clientEdition === undefined ||
    !Array.isArray(tsEditions)
  ) {
    return [];
  }
  if (tsEditions.includes(clientEdition)) return [];

  return [
    `the client lib declared in ${CLIENT_TSCONFIG} is ${clientEdition}, but ` +
    `the installed TypeScript does not provide that edition (${
      tsEditions.join(", ")
    })`,
  ];
}

/** Compare the generated deployment configuration with the lock. */
export function generatedConfigProblems(root, runtime) {
  const file = path.join(root, DEPLOY_CONFIG);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return [`${DEPLOY_CONFIG} is not valid JSON: ${error.message}`];
  }

  const problems = [];
  const expectedDate = runtime.values["runtime.compatibility.date"]?.value;
  const expectedFlags = runtime.values["runtime.compatibility.flags"]?.value;

  if (config.compatibility_date !== expectedDate) {
    problems.push(
      `${DEPLOY_CONFIG} compatibility_date is ` +
        `${JSON.stringify(config.compatibility_date)}, but the lock records ` +
        `${JSON.stringify(expectedDate)}`,
    );
  }
  if (!compare(config.compatibility_flags ?? [], expectedFlags)) {
    problems.push(
      `${DEPLOY_CONFIG} compatibility_flags are ` +
        `${
          JSON.stringify(config.compatibility_flags ?? [])
        }, but the lock records ${JSON.stringify(expectedFlags)}`,
    );
  }

  return problems;
}

/**
 * Verify the current environment against the committed lock.
 *
 * Returns the per-run report whether or not verification passes, so a failing
 * run still produces machine-readable evidence.
 */
export async function verifyContracts(root = Deno.cwd(), toolchainRoot = root) {
  const document = loadDocument(root);
  const digest = await lockDigest(document);
  const identity = await currentIdentity(root, toolchainRoot);
  const report = await buildConformanceReport({
    document,
    identity,
    digest,
  });

  const problems = [
    ...report.problems,
    ...ruleProblems(document, report, identity, root),
  ];
  report.problems = problems;
  report.verdict = problems.length === 0 ? "conformant" : "drifted";

  return {
    document,
    identity,
    report,
    problems,
    notes: [
      `lock ${digest}`,
      `checked ${SCOPES.length} scopes for ${identity.platform.key}`,
      "verification performs no discovery: measured values are recorded by " +
      "`deno task contract:refresh`",
    ],
  };
}

/** Human-readable one-line status for a scope entry. */
export function summariseScope(entry) {
  const recorded = entry.recordedFingerprint === null
    ? "(none)"
    : entry.recordedFingerprint.replace("sha256:", "").slice(0, 12);
  const derived = entry.derivedFingerprint.replace("sha256:", "").slice(0, 12);
  return `${entry.scope} ${entry.status} recorded=${recorded} derived=${derived}`;
}
