/**
 * The approval step: the one place a contract becomes approved.
 *
 * Approval is an explicit act. It requires a named approver, a stated reason,
 * and it refuses to proceed when the candidate contains an `unverified` value.
 * It also refuses to overwrite an approved contract unless `--replace` is
 * given, so history is preserved by default.
 *
 * Policies are carried forward verbatim unless `reaffirm` is requested. That is
 * what makes a toolchain change force a human review instead of silently
 * re-blessing an old decision: the policy keeps the fingerprint it was reviewed
 * against, and verification fails until someone reaffirms it.
 */

import { describePermissionProfiles } from "./permissions.mjs";
import { ContractError, unverifiedValues } from "./schema.mjs";
import { mergeContracts } from "./store.mjs";

export const CLIENT_API_POLICY = "clientApiEdition";
export const PERMISSION_POLICY = "permissionProfiles";

function fail(message) {
  throw new ContractError(message);
}

function keyForScope(contracts, scope) {
  const entry = Object.entries(contracts).find(([, contract]) =>
    contract.scope === scope
  );
  if (entry === undefined) fail(`candidate has no ${scope} contract`);
  return entry[0];
}

/**
 * Build the declared policies for a new or reaffirmed approval.
 *
 * `clientApiEdition` is required: it is a human decision about which browser
 * APIs the project is willing to depend on, and nothing installed can derive
 * it. The permission profiles are the ones the project's launchers declare
 * today; recording them here makes an unreviewed change visible in CI.
 */
export function buildPolicies({
  contracts,
  by,
  at,
  clientApiEdition,
  rationale = {},
  permissionRationale = {},
  root = Deno.cwd(),
}) {
  if (typeof clientApiEdition !== "string" || clientApiEdition.length === 0) {
    fail(
      "a declared client API edition is required. Pass --client-api-edition " +
        "(for example es2023); it is a policy, not a discovery result.",
    );
  }

  const viteKey = keyForScope(contracts, "vite-syntax-target");
  const typescriptKey = keyForScope(contracts, "typescript-libraries");
  const runtimeKey = keyForScope(contracts, "workerd-runtime");

  return {
    [CLIENT_API_POLICY]: {
      provenance: "declared",
      value: clientApiEdition,
      rationale: rationale[CLIENT_API_POLICY] ??
        "No installed tool carries a browser-API database, so the correspondence " +
          "between an ES edition and Vite's resolved browser targets stays a " +
          "reviewed human decision.",
      decidedBy: by,
      decidedAt: at,
      reviewedAgainst: [viteKey, typescriptKey],
      checkedAgainst: ["tsconfig.json compilerOptions.lib"],
    },
    [PERMISSION_POLICY]: {
      provenance: "declared",
      value: describePermissionProfiles(root),
      rationale: permissionRationale[PERMISSION_POLICY] ??
        "Each launcher grants only what its operation declares. Discovery never " +
          "adds a grant: a tool's observed needs are not permission.",
      decidedBy: by,
      decidedAt: at,
      reviewedAgainst: [runtimeKey],
      checkedAgainst: [
        "scripts/vite-build.mjs buildViteArgs",
        "scripts/wrangler-types.mjs buildWranglerTypesArgs",
        "scripts/wrangler-dry-run.mjs buildWranglerDryRunArgs",
      ],
    },
  };
}

/** Problems that make a candidate unapprovable. */
export function approvalProblems({ existing, candidate, replace }) {
  const problems = [];

  for (const [key, contract] of Object.entries(candidate.contracts)) {
    const unverified = unverifiedValues(contract);
    if (unverified.length > 0) {
      problems.push(
        `contract ${key} has unverified values: ${unverified.join(", ")}`,
      );
    }
    if (existing?.contracts?.[key]?.state === "approved" && !replace) {
      problems.push(
        `contract ${key} is already approved; pass --replace to re-approve it`,
      );
    }
  }

  return problems;
}

/**
 * Approve a candidate document and return the merged, approved document.
 *
 * `reaffirm` rebuilds the policies against the candidate's fingerprints, which
 * is the explicit review step after a toolchain change.
 */
export function approveCandidate({
  existing,
  candidate,
  by,
  reason,
  at,
  replace = false,
  reaffirm = false,
  clientApiEdition,
  root = Deno.cwd(),
}) {
  if (typeof by !== "string" || by.trim().length === 0) {
    fail("approval requires a named approver (--by)");
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    fail("approval requires a stated reason (--reason)");
  }
  const hasApproved = existing !== undefined &&
    Object.values(existing.contracts).some((contract) =>
      contract.state === "approved"
    );
  if (!hasApproved) {
    // A provisional baseline carries policy authorship that no human supplied;
    // the first genuine approval must state the policies itself.
    reaffirm = true;
  }

  const problems = approvalProblems({ existing, candidate, replace });
  if (problems.length > 0) {
    fail(problems.join("\n"));
  }

  const contracts = {};
  for (const [key, contract] of Object.entries(candidate.contracts)) {
    contracts[key] = {
      ...contract,
      state: "approved",
      approved: {
        by,
        at,
        reason,
        fingerprint: contract.fingerprint,
      },
      bootstrap: null,
    };
  }

  const policies = reaffirm
    ? buildPolicies({
      contracts,
      by,
      at,
      clientApiEdition,
      root,
    })
    : existing.policies;

  if (!reaffirm && Object.keys(policies).length === 0) {
    fail("no policies to carry forward; pass --reaffirm to declare them");
  }

  return {
    ...mergeContracts(existing, { ...candidate, contracts }),
    policies,
  };
}
