/**
 * CI verification: enforce an approved contract, discover nothing.
 *
 * Every input here is a file read or an in-memory comparison. This module never
 * spawns workerd, Vite or any other tool, so CI cannot accidentally *create*
 * evidence — it can only confirm that the environment and the generated
 * configuration still match the decision a human approved.
 */

import { readFileSync } from "../lib/fs.mjs";
import path from "../lib/path.mjs";
import { canonicalJson, contractKey, fingerprintOf } from "./canonical.mjs";
import {
  CLIENT_TSCONFIG,
  readLibs,
  readWranglerConfig,
  WORKER_TSCONFIG,
} from "./config.mjs";
import {
  fingerprintInputs,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_WORKERD_RUNTIME,
  SCOPES,
} from "./scopes.mjs";
import { describePermissionProfiles } from "./permissions.mjs";
import { ContractError, isApproved, unverifiedValues } from "./schema.mjs";
import { loadDocument } from "./store.mjs";
import { platformIdentity, resolvePackageIdentity } from "./toolchain.mjs";

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
  // Key order is not meaningful in JSON; compare the canonical form so a
  // document round-tripped through disk never "differs" by ordering alone.
  return canonicalJson(actual, 0) === canonicalJson(expected, 0);
}

/** Current toolchain identity, read without executing anything. */
export function currentIdentity(root) {
  const platform = platformIdentity();
  const wrangler = readWranglerConfig(root);
  const { typescript, vite, graph } = resolvePackageIdentity(root);

  return {
    platform,
    wrangler,
    typescript,
    vite,
    graph,
    inputs: {
      platform: platform.key,
      workerd: {
        version: graph.workerdVersion,
        compatibilityDate: wrangler.compatibilityDate,
        compatibilityFlags: wrangler.compatibilityFlags,
      },
      vite: { version: vite.manifest.version },
      typescript: { version: typescript.manifest.version },
    },
  };
}

/** Locate the approved contract for one scope, distinguishing stale from absent. */
export async function findContract(document, scope, inputs) {
  const fingerprint = await fingerprintOf(fingerprintInputs(scope, inputs));
  const key = contractKey(scope, fingerprint);
  const contract = document.contracts[key];

  if (contract !== undefined) return { key, contract };

  const inputsLabel = JSON.stringify(fingerprintInputs(scope, inputs));
  const known = Object.entries(document.contracts)
    .filter(([, entry]) => entry.scope === scope)
    .map(([knownKey]) => knownKey);

  if (known.length > 0) {
    throw new ContractError(
      `the approved ${scope} contract is stale: the installed toolchain ` +
        `fingerprints to ${fingerprint}, but the document approves ` +
        `${known.join(", ")}. Inputs: ${inputsLabel}. ` +
        `Run the local discovery and approval cycle and commit the result.`,
    );
  }

  throw new ContractError(
    `no approved contract for scope ${scope}. Inputs: ${inputsLabel}. ` +
      `Run the local discovery and approval cycle and commit the result.`,
  );
}

export async function verifyContracts(root = Deno.cwd()) {
  const document = loadDocument(root);
  const identity = currentIdentity(root);
  const problems = [];
  const notes = [];

  const located = {};
  for (const scope of SCOPES) {
    try {
      located[scope] = await findContract(document, scope, identity.inputs);
    } catch (error) {
      if (error instanceof ContractError) problems.push(error.message);
      else throw error;
    }
  }

  if (problems.length > 0) return { document, problems, notes };

  for (const scope of SCOPES) {
    const { key, contract } = located[scope];

    if (!isApproved(contract)) {
      problems.push(describeUnapproved(key, contract));
    }

    const unverified = unverifiedValues(contract);
    if (unverified.length > 0) {
      problems.push(
        `contract ${key} contains unverified values: ${unverified.join(", ")}`,
      );
    }

    const current = fingerprintInputs(scope, identity.inputs);
    if (!compare(contract.fingerprintInputs, current)) {
      problems.push(
        `contract ${key} fingerprint inputs do not match the current toolchain`,
      );
    }
  }

  const runtime = located[SCOPE_WORKERD_RUNTIME].contract;
  const typescriptContract = located[SCOPE_TYPESCRIPT_LIBRARIES].contract;
  const clientPolicy = document.policies.clientApiEdition;
  const permissionPolicy = document.policies.permissionProfiles;

  if (clientPolicy === undefined) {
    problems.push("the document declares no clientApiEdition policy");
  }
  if (permissionPolicy === undefined) {
    problems.push("the document declares no permissionProfiles policy");
  }

  const workerDeclared = declaredEdition(readLibs(root, WORKER_TSCONFIG));
  const workerExpected = runtime.values["typescript.worker.libEdition"]?.value;
  if (workerExpected === undefined) {
    problems.push(
      "the workerd-runtime contract declares no typescript.worker.libEdition",
    );
  } else if (workerDeclared !== workerExpected) {
    problems.push(
      `${WORKER_TSCONFIG} declares ${
        workerDeclared ?? "no ES edition"
      }, but the ` +
        `approved contract measured ${workerExpected}`,
    );
  }

  const tsEditions = typescriptContract.values["typescript.editions"]?.value;
  if (!Array.isArray(tsEditions)) {
    problems.push(
      "the typescript-libraries contract declares no typescript.editions",
    );
  } else if (
    typeof workerExpected === "string" && !tsEditions.includes(workerExpected)
  ) {
    problems.push(
      `the contract derives worker edition ${workerExpected}, but the installed ` +
        `TypeScript does not provide it (${tsEditions.join(", ")})`,
    );
  }

  const clientDeclared = declaredEdition(readLibs(root, CLIENT_TSCONFIG));
  if (clientPolicy !== undefined && clientDeclared !== clientPolicy.value) {
    problems.push(
      `${CLIENT_TSCONFIG} declares ${
        clientDeclared ?? "no ES edition"
      }, but the ` +
        `approved client API policy is ${clientPolicy.value}`,
    );
  }
  problems.push(...clientEditionProblems(clientPolicy, tsEditions));

  const runtimeDate = runtime.values["runtime.compatibility.date"]?.value;
  const runtimeFlags = runtime.values["runtime.compatibility.flags"]?.value;
  if (runtimeDate !== identity.wrangler.compatibilityDate) {
    problems.push(
      `wrangler.jsonc compatibility_date is ${identity.wrangler.compatibilityDate}, ` +
        `but the approved contract measured ${runtimeDate}`,
    );
  }
  if (!compare(runtimeFlags, identity.wrangler.compatibilityFlags)) {
    problems.push(
      `wrangler.jsonc compatibility_flags are ` +
        `${JSON.stringify(identity.wrangler.compatibilityFlags)}, but the ` +
        `approved contract measured ${JSON.stringify(runtimeFlags)}`,
    );
  }

  problems.push(...generatedConfigProblems(root, runtime));
  problems.push(...policyProblems(document, located, root));

  notes.push(`verified ${SCOPES.length} scopes for ${identity.platform.key}`);
  notes.push(
    `Vite ${identity.vite.manifest.version} target mapping is fixed by the ` +
      `approved vite-syntax-target contract; CI does not re-run Vite`,
  );

  return { document, problems, notes };
}

/** Compare the generated deployment configuration with the contract. */
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
        `${JSON.stringify(config.compatibility_date)}, but the approved ` +
        `contract measured ${JSON.stringify(expectedDate)}`,
    );
  }
  if (!compare(config.compatibility_flags ?? [], expectedFlags)) {
    problems.push(
      `${DEPLOY_CONFIG} compatibility_flags are ` +
        `${
          JSON.stringify(config.compatibility_flags ?? [])
        }, but the approved ` +
        `contract measured ${JSON.stringify(expectedFlags)}`,
    );
  }

  return problems;
}

/** Policy freshness (was it reviewed against these contracts?) and conformance. */
export function policyProblems(document, located, root) {
  const problems = [];
  const currentKeys = new Set(
    Object.values(located).map((entry) => entry.key),
  );

  for (const [name, policy] of Object.entries(document.policies)) {
    for (const reviewed of policy.reviewedAgainst) {
      if (!currentKeys.has(reviewed)) {
        problems.push(
          `policy ${name} was reviewed against ${reviewed}, which is not the ` +
            `current contract; rediscover and reaffirm the policy`,
        );
      }
    }
  }

  const permissions = document.policies.permissionProfiles;
  if (permissions !== undefined) {
    const declared = describePermissionProfiles(root);
    if (!compare(permissions.value, declared)) {
      problems.push(
        "the permission profiles declared by scripts/*.mjs differ from the " +
          "approved policy; review and reaffirm before granting anything",
      );
    }
  }

  return problems;
}

/** Explain why a contract is not acceptable to CI, naming its lifecycle state. */
export function describeUnapproved(key, contract) {
  if (contract.state === "bootstrap") {
    return `contract ${key} is a provisional bootstrap baseline (${
      contract.bootstrap?.reason ?? "no reason recorded"
    }); a human must approve it before CI can accept it`;
  }
  if (contract.state === "candidate") {
    return `contract ${key} is an unapproved candidate; run the explicit ` +
      `approval step and commit the result`;
  }

  return `contract ${key} declares state ${JSON.stringify(contract.state)} ` +
    `but its approval does not cover fingerprint ${contract.fingerprint}`;
}

/**
 * A declared client edition must exist in the compiler that is installed.
 *
 * The policy is a human decision about browser APIs, but it is expressed as a
 * TypeScript edition, so an edition the compiler does not ship cannot be
 * verified at all.
 */
export function clientEditionProblems(clientPolicy, tsEditions) {
  if (
    clientPolicy === undefined || !Array.isArray(tsEditions) ||
    typeof clientPolicy.value !== "string"
  ) {
    return [];
  }
  if (tsEditions.includes(clientPolicy.value)) return [];

  return [
    `the client API policy declares ${clientPolicy.value}, but the installed ` +
    `TypeScript does not provide that edition (${tsEditions.join(", ")})`,
  ];
}
