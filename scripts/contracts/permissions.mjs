/**
 * Describe the declared permission profiles as contract facts.
 *
 * Each profile is a pure function of the launcher's own argument builder, so it
 * cannot drift from the code that runs: changing a launcher's grants changes
 * this derivation and therefore the `launcher-permissions` fingerprint. The
 * recorded requirement is what the launcher declares; what the environment
 * actually grants is enforced by Deno at run time, and a `NotCapable` failure is
 * an execution failure rather than a reason to widen anything here.
 *
 * Absolute paths are normalised: the project root becomes `<root>` and any
 * other absolute path keeps only its basename. A lock is committed, so it must
 * not contain a path from the machine that authored it.
 */

import { buildEdgeVerifyArgs } from "../edge-verify.mjs";
import {
  buildViteArgs,
  DEFAULT_VITE_PERMISSION_PROFILE,
  VITE_PERMISSION_PROFILES,
} from "../vite-build.mjs";
import { buildWranglerDryRunArgs } from "../wrangler-dry-run.mjs";
import { buildWranglerTypesArgs } from "../wrangler-types.mjs";
import { join } from "../lib/path.mjs";

function normaliseValue(value, root) {
  const rootPrefix = root.endsWith("/") ? root : `${root}/`;

  return value.split(",").map((entry) => {
    if (entry === root) return "<root>";
    if (entry.startsWith(rootPrefix)) {
      return `<root>/${entry.slice(rootPrefix.length)}`;
    }
    if (entry.startsWith("/")) {
      return `<path>/${entry.slice(entry.lastIndexOf("/") + 1)}`;
    }
    return entry;
  }).join(",");
}

/** Keep only permission flags, normalised so they are machine-independent. */
export function normalisePermissionFlags(args, root) {
  return args
    .filter((argument) => argument.startsWith("--allow-"))
    .map((argument) => {
      const separator = argument.indexOf("=");
      if (separator === -1) return argument;
      const name = argument.slice(0, separator);
      return `${name}=${normaliseValue(argument.slice(separator + 1), root)}`;
    });
}

/**
 * Contract key for one Vite profile; the default profile keeps the plain name.
 *
 * Deriving the keys from the launcher's profile list means a profile cannot be
 * added or renamed without changing the policy.
 */
function viteProfileKey(profile) {
  return profile === DEFAULT_VITE_PERMISSION_PROFILE
    ? "vite-build"
    : `vite-build-${profile}`;
}

/**
 * Build the declared profile of every external-tool launcher.
 *
 * Synthetic invocation values are used for the Vite profile: only the declared
 * permission flags are compared, so no resolution or execution is involved.
 */
export function describePermissionProfiles(root = Deno.cwd()) {
  const viteInvocation = {
    viteBin: "<vite>",
    rolldown: "<rolldown>",
    lightningcss: "<lightningcss>",
  };

  const wranglerTypesArgs = buildWranglerTypesArgs({
    wranglerCli: "<wrangler>",
    workerd: "<workerd>",
    esbuild: "<esbuild>",
  });

  const dryRunArgs = buildWranglerDryRunArgs(
    { wranglerCli: "<wrangler>", esbuild: "<esbuild>" },
    root,
  );

  const edgeVerifyArgs = buildEdgeVerifyArgs({
    script: "<edge-verify>",
    chrome: "<chrome>",
    criteriaDir: join(root, "acceptance"),
    artifactsDir: join(root, "artifacts"),
  });

  const viteProfiles = Object.fromEntries(
    VITE_PERMISSION_PROFILES.map((profile) => [
      viteProfileKey(profile),
      normalisePermissionFlags(
        buildViteArgs(viteInvocation, [], profile),
        root,
      ),
    ]),
  );

  return {
    ...viteProfiles,
    "wrangler-types": normalisePermissionFlags(wranglerTypesArgs, root),
    "wrangler-dry-run": normalisePermissionFlags(dryRunArgs, root),
    "edge-verify": normalisePermissionFlags(edgeVerifyArgs, root),
  };
}
