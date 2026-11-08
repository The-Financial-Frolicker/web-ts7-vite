/**
 * Current toolchain identity, read from files only.
 *
 * This module is shared by refresh and verification so the two cannot derive
 * different facts. Every field here is obtainable without executing a tool:
 * package manifests, the project configuration and the launcher argument
 * builders. That is what makes the read-only conformance gate possible.
 *
 * Values that can only be *measured* (workerd capability probes, Vite's resolved
 * browser list, TypeScript's shipped editions) are recorded by `contract:refresh`
 * and are never recomputed by CI.
 */

import { fingerprintOf } from "./canonical.mjs";
import {
  CLIENT_TSCONFIG,
  readLibs,
  readViteBuildTarget,
  readWranglerConfig,
  WORKER_TSCONFIG,
} from "./config.mjs";
import { allCapabilities, EDITIONS } from "./fixtures.mjs";
import { describePermissionProfiles } from "./permissions.mjs";
import { platformIdentity, resolvePackageIdentity } from "./toolchain.mjs";

/**
 * Pure projection of a probe catalogue into the form that is fingerprinted.
 *
 * `editions` keeps its declared order because `deriveWorkerLibEdition` walks it
 * and assigns a candidate on each pass, so order changes the derived edition.
 * Capability entries are sorted by id: results are keyed by id, so declaration
 * order carries no meaning and sorting keeps a reordering from churning the
 * fingerprint.
 */
export function catalogueInputs(editions, capabilities) {
  const projected = capabilities
    .map((entry) =>
      entry.edition === undefined
        ? { id: entry.id, expression: entry.expression }
        : { id: entry.id, edition: entry.edition, expression: entry.expression }
    )
    .sort((
      left,
      right,
    ) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  return { editions: [...editions], capabilities: projected };
}

/** The catalogue this project declares: the obligations the runtime must meet. */
export function probeCatalogue() {
  return catalogueInputs(EDITIONS, allCapabilities());
}

/**
 * Digest of the declared catalogue.
 *
 * This is what makes an obligation edit visible at the conformance gate: the
 * catalogue is an input to the workerd-runtime claim, not merely a description
 * of it, so changing which capabilities are probed changes the fingerprint.
 */
export async function probeCatalogueDigest() {
  return await fingerprintOf(probeCatalogue());
}

export async function currentIdentity(
  root = Deno.cwd(),
  generatorInstallationRoot = root,
) {
  const platform = platformIdentity();
  const wrangler = readWranglerConfig(root);
  const { typescript, vite, graph } = resolvePackageIdentity(
    generatorInstallationRoot,
  );

  return {
    platform,
    wrangler,
    graph,
    typescript: {
      manifest: typescript.manifest,
      clientLib: readLibs(root, CLIENT_TSCONFIG),
      workerLib: readLibs(root, WORKER_TSCONFIG),
    },
    vite: {
      manifest: vite.manifest,
      buildTarget: readViteBuildTarget(root),
    },
    launchers: describePermissionProfiles(root, generatorInstallationRoot),
    capabilities: await probeCatalogueDigest(),
  };
}

/**
 * The identity mirror consumed by `fingerprintInputs`.
 *
 * One projection, built from the same identity object, so refresh and
 * verification always fingerprint the same shape.
 */
export function contractInputs(identity) {
  return {
    platform: identity.platform.key,
    workerd: {
      version: identity.graph.workerdVersion,
      compatibilityDate: identity.wrangler.compatibilityDate,
      compatibilityFlags: identity.wrangler.compatibilityFlags,
    },
    vite: {
      version: identity.vite.manifest.version,
      buildTarget: identity.vite.buildTarget,
    },
    typescript: {
      version: identity.typescript.manifest.version,
      clientLib: identity.typescript.clientLib,
      workerLib: identity.typescript.workerLib,
    },
    launchers: identity.launchers,
    capabilities: identity.capabilities,
  };
}
