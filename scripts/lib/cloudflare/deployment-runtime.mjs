/**
 * Deployment runtime compatibility.
 *
 * `wrangler` executes the workerd runtime for type generation, the deployment
 * dry run and deployment itself. The Cloudflare Vite plugin brings its own
 * Miniflare graph into the application-owned dependency closure. If those two
 * graphs select different runtimes, the artefact was built against one runtime
 * and would execute on another.
 *
 * That is a **deployment-integration** fact. It is checked here, at the
 * deployment boundary, and never in `toolchain-contracts.json`: certification
 * covers the build toolchain and does not depend on deployment policy.
 *
 * The package-graph walk is not repeated here — it is the shared capability in
 * `./workerd-runtime.mjs`. This module contributes only the policy: two graphs
 * must both resolve and must agree on the runtime version *and* on the canonical
 * platform binary. The binary comparison is environment-local evidence (a real
 * path on this machine); it is not a portable identity and must never enter a
 * toolchain digest.
 */

import { resolveWorkerdRuntime } from "./workerd-runtime.mjs";

/** The two graphs that must agree before a deployment executes. */
export const DEPLOYMENT_GRAPHS = Object.freeze([
  "wrangler",
  "@cloudflare/vite-plugin",
]);

export class DeploymentRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentRuntimeError";
  }
}

function fail(message) {
  throw new DeploymentRuntimeError(message);
}

/** Resolve one graph, turning any resolution failure into a deployment error. */
function resolveGraph(nodeModules, packageName) {
  try {
    return resolveWorkerdRuntime(nodeModules, packageName);
  } catch (error) {
    fail(
      `deployment runtime incompatible: the ${packageName} dependency graph ` +
        `could not be resolved (${error.message})`,
    );
  }
}

/**
 * Compare two resolved runtimes. Pure: no filesystem access, so the version and
 * binary branches are both exercisable without manufacturing installations.
 */
export function compareDeploymentRuntimes(left, right) {
  if (left.workerdVersion !== right.workerdVersion) {
    fail(
      `deployment runtime incompatible: ${left.packageName} resolves workerd ` +
        `${left.workerdVersion} but ${right.packageName} resolves ` +
        `${right.workerdVersion}; the artefact was produced against one runtime ` +
        `and would deploy on another`,
    );
  }

  if (left.binary !== right.binary) {
    fail(
      `deployment runtime incompatible: both graphs resolve workerd ` +
        `${left.workerdVersion}, but ${left.packageName} selects the binary at ` +
        `${left.binary} while ${right.packageName} selects ` +
        `${right.binary}; the artefact would execute on a runtime the build ` +
        `never exercised`,
    );
  }

  return {
    workerdVersion: left.workerdVersion,
    platformPackage: left.platformPackage,
    binary: left.binary,
    graphs: [left.requiredBy, right.requiredBy],
  };
}

/**
 * Assert that the deployment's dependency tree selects one coherent runtime.
 *
 * Fails closed if either graph, its packages, the platform package or the
 * platform binary cannot be resolved.
 */
export function assertDeploymentRuntime({ nodeModules }) {
  const resolved = DEPLOYMENT_GRAPHS.map((name) =>
    resolveGraph(nodeModules, name)
  );
  return compareDeploymentRuntimes(resolved[0], resolved[1]);
}
