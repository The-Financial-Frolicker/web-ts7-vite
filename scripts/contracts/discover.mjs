/**
 * Contract derivation: measured facts in, lock document out.
 *
 * This module is the only place that executes external tools. It is reached
 * exclusively through `deno task contract:refresh`, which runs on the authorised
 * platform (Ubuntu 24.04) and commits the resulting lock as an ordinary source
 * change. CI calls `verify.mjs` instead and never runs a probe.
 *
 * Every value records what kind of statement it is and how it was established:
 *
 *   authoritative  read from the project's own configuration or the installed
 *                  package manifests
 *   observed       measured by a probe in this environment
 *   derived        computed from other values by a stated rule
 *   unverified     evidence is missing or a probe failed
 *
 * A value that ends up `unverified` blocks conformance until the cause is fixed;
 * refresh records it rather than hiding it.
 */

import { contractKey, fingerprintOf } from "./canonical.mjs";
import {
  CLIENT_TSCONFIG,
  DEFAULT_VITE_BUILD_TARGET,
  WORKER_TSCONFIG,
} from "./config.mjs";
import { capabilitiesForEdition, EDITIONS } from "./fixtures.mjs";
import { contractInputs, currentIdentity } from "./identity.mjs";
import {
  fingerprintInputs,
  SCOPE_LAUNCHER_PERMISSIONS,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_VITE_TARGET,
  SCOPE_WORKERD_RUNTIME,
  SCOPES,
} from "./scopes.mjs";
import { SCHEMA_VERSION } from "./schema.mjs";
import { describeToolchain } from "./toolchain.mjs";
import { generatorInstallationRoot } from "../lib/toolchain/runtime.mjs";
import { runCapabilityProbe } from "./workerd-probe.mjs";
import {
  discoverTypeScript,
  DiscoveryError,
} from "../lib/toolchain/discovery.mjs";
import { discoverViteTargets } from "../lib/toolchain/vite.mjs";

// Re-exported so refresh's callers keep one import site; the verifier imports
// `scopes.mjs` directly and therefore never loads this module.
export {
  fingerprintInputs,
  SCOPE_LAUNCHER_PERMISSIONS,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_VITE_TARGET,
  SCOPE_WORKERD_RUNTIME,
  SCOPES,
};

/** Which argument builder declares each recorded launcher profile. */
const LAUNCHER_SOURCES = Object.freeze({
  "vite-build": "scripts/vite-build.mjs buildViteArgs (local profile)",
  "vite-build-ci-runner":
    "scripts/vite-build.mjs buildViteArgs (ci-runner profile)",
  "vite-probe": "scripts/vite-build.mjs buildViteProbeArgs (local profile)",
  "vite-probe-ci-runner":
    "scripts/vite-build.mjs buildViteProbeArgs (ci-runner profile)",
  "wrangler-types": "scripts/wrangler-types.mjs buildWranglerTypesArgs",
  "wrangler-dry-run": "scripts/wrangler-dry-run.mjs buildWranglerDryRunArgs",
  "edge-verify": "scripts/edge-verify.mjs buildEdgeVerifyArgs",
});
/**
 * Canonical refresh requires the authorised Emscripten installation.
 *
 * The lock records how the WASM artefact is produced. Refreshing without the SDK
 * would record degraded provenance and make the committed artefact depend on
 * whichever machine happened to refresh it, so refresh fails instead.
 *
 * Verification never calls this: the read-only conformance gate needs no
 * compiler, and keeping it free of that requirement is deliberate.
 */
export function requireEmscripten(
  env = Deno.env,
  stat = (target) => Deno.statSync(target),
) {
  const root = env.get("EMSDK");
  if (typeof root !== "string" || root.length === 0) {
    throw new DiscoveryError(
      "canonical contract refresh requires the authorised Emscripten SDK, but " +
        "EMSDK is not set. Install the pinned toolchain with `mise install` " +
        "and run refresh under `mise exec --`.",
    );
  }

  try {
    if (!stat(root).isDirectory) throw new Error("not a directory");
  } catch (error) {
    throw new DiscoveryError(
      `EMSDK points at ${root}, which is not a readable SDK directory ` +
        `(${error.message}); install the pinned toolchain with \`mise install\`.`,
    );
  }

  return root;
}

/**
 * Derive the Worker's TypeScript library edition from measured capabilities.
 *
 * Conservative by construction: an edition is claimed only when every edition
 * up to and including it is fully supported. One failed probe stops the chain
 * as unverified rather than being read as a negative result.
 *
 * `editions` and `entriesFor` are injected with their production defaults so the
 * empty-edition guard below can be exercised without editing the real catalogue;
 * no caller passes them.
 */
export function deriveWorkerLibEdition(
  results,
  editions = EDITIONS,
  entriesFor = capabilitiesForEdition,
) {
  let edition = null;
  const supported = [];

  for (const candidate of editions) {
    const entries = entriesFor(candidate);
    // An edition with no probes is unproven, not proven: without this guard the
    // empty outcome list satisfies both checks below and the loop would advance
    // `edition` to `candidate`, claiming support for an edition nothing tested.
    if (entries.length === 0) {
      return {
        edition,
        provenance: "unverified",
        evidence: `${candidate} has no probes; the edition chain stops at ` +
          `${edition ?? "no edition"}`,
      };
    }

    const outcomes = entries.map((entry) => ({
      id: entry.id,
      outcome: results[entry.id]?.outcome ?? "probe-failed",
    }));

    const failed = outcomes.find((entry) => entry.outcome === "probe-failed");
    if (failed !== undefined) {
      return {
        edition,
        provenance: "unverified",
        evidence:
          `${candidate} capability probe ${failed.id} could not establish a ` +
          `result; the edition chain stops at ${edition ?? "no edition"}`,
      };
    }

    const unsupported = outcomes.filter((entry) =>
      entry.outcome === "unsupported"
    );
    if (unsupported.length > 0) {
      if (edition === null) {
        return {
          edition: null,
          provenance: "unverified",
          evidence:
            `${candidate} is not fully supported (${
              unsupported.map((entry) => entry.id).join(", ")
            }); ` +
            `no edition can be claimed`,
        };
      }

      return {
        edition,
        provenance: "derived",
        evidence:
          `${supported.join(", ")} supported; ${
            unsupported.map((entry) => `${entry.id} unsupported`).join(", ")
          }; ` +
          `worker lib edition is the newest fully supported edition`,
      };
    }

    supported.push(
      `${candidate} (${entries.map((entry) => entry.id).join(", ")})`,
    );
    edition = candidate;
  }

  return {
    edition,
    provenance: "derived",
    evidence:
      `every probed edition was fully supported (${supported.join("; ")}); ` +
      `worker lib edition is the newest of them`,
  };
}

/**
 * Assemble a lock document from derived facts.
 *
 * Pure apart from SHA-256: no timestamps, no run identifiers, no host paths and
 * no approval metadata, so two refreshes of the same authorised configuration on
 * the same platform produce byte-identical output.
 */
export async function buildLock({ identity, toolchain, values }) {
  const inputs = contractInputs(identity);
  const contracts = {};

  for (const scope of SCOPES) {
    const scopeInputs = fingerprintInputs(scope, inputs);
    const fingerprint = await fingerprintOf(scopeInputs);
    const key = contractKey(scope, fingerprint);

    contracts[key] = {
      scope,
      fingerprint,
      fingerprintInputs: scopeInputs,
      values: values[scope] ?? {},
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    toolchain,
    contracts,
  };
}

/** Recorded values for the workerd runtime scope. */
function runtimeValues({ identity, probe, edition }) {
  const values = {
    "runtime.workerd.version": {
      kind: "identity",
      value: identity.graph.workerdVersion,
      provenance: "authoritative",
      evidence: `installed package manifests: ${identity.graph.detail}`,
    },
    "runtime.compatibility.date": {
      kind: "configuration",
      value: identity.wrangler.compatibilityDate,
      provenance: "authoritative",
      evidence: `${identity.wrangler.file} compatibility_date`,
    },
    "runtime.compatibility.flags": {
      kind: "configuration",
      value: identity.wrangler.compatibilityFlags,
      provenance: "authoritative",
      evidence: `${identity.wrangler.file} compatibility_flags`,
    },
    "typescript.worker.libEdition": {
      kind: "derived",
      value: edition.edition,
      provenance: edition.provenance,
      evidence: edition.evidence,
    },
  };

  for (const [id, result] of Object.entries(probe.results)) {
    values[`runtime.capability.${id}`] = {
      kind: "capability",
      value: result.outcome,
      provenance: result.outcome === "probe-failed" ? "unverified" : "observed",
      evidence: `${result.detail}; ${probe.evidence}`,
    };
  }

  return values;
}

/** Recorded values for the Vite target scope. */
function viteValues({ identity, viteTargets }) {
  return {
    "vite.build.target": {
      kind: "configuration",
      value: identity.vite.buildTarget,
      provenance: "authoritative",
      evidence: identity.vite.buildTarget === DEFAULT_VITE_BUILD_TARGET
        ? `vite.config.ts declares no build.target; Vite's symbolic default applies`
        : `vite.config.ts build.target`,
    },
    "vite.build.targets": {
      kind: "observed",
      value: viteTargets.targets,
      provenance: "observed",
      evidence:
        `Vite ${viteTargets.version} resolveConfig({ configFile: false }, "build")` +
        `.build.target`,
    },
  };
}

/** Recorded values for the TypeScript libraries scope. */
function typescriptValues({ identity, typescriptLibs }) {
  // Describe the source of the observation without embedding a layout: the same
  // artefact is reachable through a project-local install, a shared Deno store
  // or a symlinked node_modules, and the committed lock must be identical for
  // all of them.
  const libDescription =
    `lib.*.d.ts files of the installed TypeScript ${typescriptLibs.version}`;
  return {
    "typescript.clientLib": {
      kind: "configuration",
      value: identity.typescript.clientLib,
      provenance: "authoritative",
      evidence: `${CLIENT_TSCONFIG} compilerOptions.lib`,
    },
    "typescript.workerLib": {
      kind: "configuration",
      value: identity.typescript.workerLib,
      provenance: "authoritative",
      evidence: `${WORKER_TSCONFIG} compilerOptions.lib`,
    },
    "typescript.editions": {
      kind: "observed",
      value: typescriptLibs.editions,
      provenance: "observed",
      evidence: libDescription,
    },
    "typescript.libraries": {
      kind: "observed",
      value: typescriptLibs.libraries,
      provenance: "observed",
      evidence: libDescription,
    },
  };
}

/** Recorded values for the launcher permission scope. */
function launcherValues({ launchers }) {
  const values = {};
  for (const [name, flags] of Object.entries(launchers)) {
    values[`launcher.${name}`] = {
      kind: "permission-profile",
      value: flags,
      provenance: "derived",
      evidence: LAUNCHER_SOURCES[name] ?? "scripts/*.mjs build*Args",
    };
  }
  return values;
}

/**
 * Derive every contract fact and return the lock document.
 *
 * The only caller is `contract:refresh`; it is never invoked by a build,
 * verification or deployment.
 */
export async function deriveContracts({
  root = Deno.cwd(),
  io = console,
  probeTimeoutMs = 25_000,
  tempRoot,
  vitePermissionProfile = "local",
} = {}) {
  const identity = await currentIdentity(root, generatorInstallationRoot());
  const toolchain = describeToolchain(root, generatorInstallationRoot());
  const emsdkRoot = requireEmscripten();

  io.log(`[refresh] emscripten SDK ${emsdkRoot}`);

  io.log(
    `[refresh] platform ${identity.platform.key}; wrangler ` +
      `${identity.graph.wranglerVersion} -> workerd ` +
      `${identity.graph.workerdVersion}`,
  );
  io.log(
    `[refresh] compatibility date ${identity.wrangler.compatibilityDate}, ` +
      `flags [${identity.wrangler.compatibilityFlags.join(", ")}] from ` +
      `${identity.wrangler.file}`,
  );
  io.log(
    `[refresh] vite ${identity.vite.manifest.version} build target ` +
      `${JSON.stringify(identity.vite.buildTarget)}`,
  );
  io.log(
    `[refresh] typescript ${identity.typescript.manifest.version}; client lib ` +
      `[${identity.typescript.clientLib.join(", ")}]; worker lib ` +
      `[${identity.typescript.workerLib.join(", ")}]`,
  );
  io.log(
    `[refresh] launcher profiles: ${
      Object.keys(identity.launchers).join(", ")
    }`,
  );

  const typescriptLibs = discoverTypeScript(generatorInstallationRoot());
  io.log(
    `[refresh] typescript editions ${typescriptLibs.editions.join(", ")}; ` +
      `libraries ${typescriptLibs.libraries.join(", ") || "none"}`,
  );

  const viteTargets = discoverViteTargets(root, {
    profile: vitePermissionProfile,
  });
  io.log(
    `[refresh] vite production targets ${viteTargets.targets.join(", ")} ` +
      `(probe profile ${vitePermissionProfile})`,
  );

  const probe = await runCapabilityProbe({
    binary: identity.graph.binary,
    workerdVersion: identity.graph.workerdVersion,
    compatibilityDate: identity.wrangler.compatibilityDate,
    compatibilityFlags: identity.wrangler.compatibilityFlags,
    timeoutMs: probeTimeoutMs,
    tempRoot,
    io,
  });

  const edition = deriveWorkerLibEdition(probe.results);
  io.log(
    `[refresh] worker lib edition: ${edition.edition ?? "none"} ` +
      `(${edition.provenance})`,
  );

  const document = await buildLock({
    identity,
    toolchain,
    values: {
      [SCOPE_WORKERD_RUNTIME]: runtimeValues({ identity, probe, edition }),
      [SCOPE_VITE_TARGET]: viteValues({ identity, viteTargets }),
      [SCOPE_TYPESCRIPT_LIBRARIES]: typescriptValues({
        identity,
        typescriptLibs,
      }),
      [SCOPE_LAUNCHER_PERMISSIONS]: launcherValues({
        launchers: identity.launchers,
      }),
    },
  });

  return { document, identity, diagnostics: probe.diagnostics };
}
