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

import {
  CLIENT_TSCONFIG,
  readLibs,
  readViteBuildTarget,
  readWranglerConfig,
  WORKER_TSCONFIG,
} from "./config.mjs";
import { describePermissionProfiles } from "./permissions.mjs";
import { platformIdentity, resolvePackageIdentity } from "./toolchain.mjs";

export function currentIdentity(root = Deno.cwd()) {
  const platform = platformIdentity();
  const wrangler = readWranglerConfig(root);
  const { typescript, vite, graph } = resolvePackageIdentity(root);

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
    launchers: describePermissionProfiles(root),
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
  };
}
