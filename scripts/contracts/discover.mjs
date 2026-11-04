/**
 * Local discovery: measured facts in, candidate contract out.
 *
 * This module is the only place that executes external tools. It is reached
 * exclusively through `contract:discover`, which is a development-station
 * operation; CI calls `verify.mjs` instead and never runs a probe.
 *
 * Every value carries what kind of statement it is and how it was established:
 *
 *   authoritative  read from the project's own configuration or the installed
 *                  package manifests
 *   observed       measured by a probe in this environment
 *   derived        computed from other values by a stated rule
 *   declared       a human decision, carried forward, never invented here
 *   unverified     evidence is missing or a probe failed
 *
 * A value that ends up `unverified` makes the candidate unapprovable.
 */

import { contractKey, fingerprintOf } from "./canonical.mjs";
import { readWranglerConfig } from "./config.mjs";
import { capabilitiesForEdition, EDITIONS } from "./fixtures.mjs";
import { SCHEMA_VERSION } from "./schema.mjs";
import {
  describeToolchain,
  platformIdentity,
  resolvePackageIdentity,
} from "./toolchain.mjs";
import { runCapabilityProbe } from "./workerd-probe.mjs";
import { discoverTypeScript } from "../lib/toolchain/discovery.mjs";
import { discoverViteTargets } from "../lib/toolchain/vite.mjs";
import path from "../lib/path.mjs";
import {
  fingerprintInputs,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_VITE_TARGET,
  SCOPE_WORKERD_RUNTIME,
  SCOPES,
} from "./scopes.mjs";

// Re-exported so discovery's callers keep one import site; the verifier imports
// `scopes.mjs` directly and therefore never loads this module.
export {
  fingerprintInputs,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_VITE_TARGET,
  SCOPE_WORKERD_RUNTIME,
  SCOPES,
};

/**
 * Derive the Worker's TypeScript library edition from measured capabilities.
 *
 * Conservative by construction: an edition is claimed only when every edition
 * up to and including it is fully supported. One failed probe stops the chain
 * as unverified rather than being read as a negative result.
 */
export function deriveWorkerLibEdition(results) {
  let edition = null;
  const supported = [];

  for (const candidate of EDITIONS) {
    const entries = capabilitiesForEdition(candidate);
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
 * Run the full local discovery and return a candidate document.
 *
 * The candidate is never approved automatically: `approved` is `null` on every
 * contract, and `policies` starts empty. Only `contract:approve` can turn it
 * into an approved artefact.
 */
export async function discoverContracts({
  root = Deno.cwd(),
  io = console,
  probeTimeoutMs = 25_000,
  tempRoot,
} = {}) {
  const platform = platformIdentity();
  const wrangler = readWranglerConfig(root);
  const { typescript, vite, graph } = resolvePackageIdentity(root);
  const toolchain = describeToolchain(root);

  io.log(
    `[discover] wrangler ${graph.wranglerVersion} -> miniflare ` +
      `${
        graph.miniflare[0].miniflareVersion
      } -> workerd ${graph.workerdVersion} ` +
      `(${platform.key})`,
  );
  io.log(
    `[discover] compatibility date ${wrangler.compatibilityDate}, flags ` +
      `[${wrangler.compatibilityFlags.join(", ")}] from ${wrangler.file}`,
  );

  const typescriptLibs = discoverTypeScript(root);
  io.log(
    `[discover] typescript ${typescriptLibs.version}: editions ` +
      `${typescriptLibs.editions.join(", ")}; libraries ` +
      `${typescriptLibs.libraries.join(", ") || "none"}`,
  );

  const viteTargets = discoverViteTargets(root);
  io.log(
    `[discover] vite ${viteTargets.version}: production targets ` +
      `${viteTargets.targets.join(", ")}`,
  );

  const probe = await runCapabilityProbe({
    binary: graph.binary,
    workerdVersion: graph.workerdVersion,
    compatibilityDate: wrangler.compatibilityDate,
    compatibilityFlags: wrangler.compatibilityFlags,
    timeoutMs: probeTimeoutMs,
    tempRoot,
    io,
  });

  const edition = deriveWorkerLibEdition(probe.results);
  io.log(
    `[discover] worker lib edition: ${edition.edition ?? "none"} ` +
      `(${edition.provenance})`,
  );

  const identity = {
    platform: platform.key,
    workerd: {
      version: graph.workerdVersion,
      compatibilityDate: wrangler.compatibilityDate,
      compatibilityFlags: wrangler.compatibilityFlags,
    },
    vite: { version: vite.manifest.version },
    typescript: { version: typescript.manifest.version },
  };

  const contracts = {};

  for (const scope of SCOPES) {
    const inputs = fingerprintInputs(scope, identity);
    const fingerprint = await fingerprintOf(inputs);
    const key = contractKey(scope, fingerprint);

    contracts[key] = {
      scope,
      fingerprint,
      fingerprintInputs: inputs,
      state: "candidate",
      approved: null,
      bootstrap: null,
      values: buildValues(scope, {
        root,
        graph,
        wrangler,
        typescriptLibs,
        viteTargets,
        probe,
        edition,
      }),
    };
  }

  return {
    document: {
      schemaVersion: SCHEMA_VERSION,
      toolchain,
      contracts,
      policies: {},
    },
    diagnostics: probe.diagnostics,
  };
}

function buildValues(scope, context) {
  const { root, graph, wrangler, typescriptLibs, viteTargets, probe, edition } =
    context;

  if (scope === SCOPE_WORKERD_RUNTIME) {
    const values = {
      "runtime.workerd.version": {
        kind: "identity",
        value: graph.workerdVersion,
        provenance: "authoritative",
        evidence: `installed package manifests: ${graph.detail}`,
      },
      "runtime.compatibility.date": {
        kind: "configuration",
        value: wrangler.compatibilityDate,
        provenance: "authoritative",
        evidence: `${wrangler.file} compatibility_date`,
      },
      "runtime.compatibility.flags": {
        kind: "configuration",
        value: wrangler.compatibilityFlags,
        provenance: "authoritative",
        evidence: `${wrangler.file} compatibility_flags`,
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
        provenance: result.outcome === "probe-failed"
          ? "unverified"
          : "observed",
        evidence: `${result.detail}; ${probe.evidence}`,
      };
    }

    return values;
  }

  if (scope === SCOPE_VITE_TARGET) {
    return {
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

  return {
    "typescript.editions": {
      kind: "observed",
      value: typescriptLibs.editions,
      provenance: "observed",
      evidence: `lib.*.d.ts files in ${
        path.relative(root, typescriptLibs.libDir)
      }`,
    },
    "typescript.libraries": {
      kind: "observed",
      value: typescriptLibs.libraries,
      provenance: "observed",
      evidence: `lib.*.d.ts files in ${
        path.relative(root, typescriptLibs.libDir)
      }`,
    },
  };
}
