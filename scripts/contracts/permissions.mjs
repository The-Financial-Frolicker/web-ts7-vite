/**
 * Describe the declared permission profiles as a policy value.
 *
 * This records what the project's own launchers *declare*; it never inspects a
 * tool's observed needs and never widens a grant. CI rebuilds the same profiles
 * from the same functions and compares them with the approved policy, so an
 * unreviewed permission change fails the build.
 *
 * Absolute paths are normalised: the project root becomes `<root>` and any
 * other absolute path keeps only its basename. A contract is committed, so it
 * must not contain a path from the machine that authored it.
 */

import { buildViteArgs } from "../vite-build.mjs";
import { buildWranglerDryRunArgs } from "../wrangler-dry-run.mjs";
import { buildWranglerTypesArgs } from "../wrangler-types.mjs";

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
 * Build the declared profile of every external-tool launcher.
 *
 * Synthetic invocation values are used for the Vite profile: only the declared
 * permission flags are compared, so no resolution or execution is involved.
 */
export function describePermissionProfiles(root = Deno.cwd()) {
  const viteArgs = buildViteArgs({
    viteBin: "<vite>",
    rolldown: "<rolldown>",
    lightningcss: "<lightningcss>",
  });

  const wranglerTypesArgs = buildWranglerTypesArgs({
    wranglerCli: "<wrangler>",
    workerd: "<workerd>",
    esbuild: "<esbuild>",
  });

  const dryRunArgs = buildWranglerDryRunArgs(
    { wranglerCli: "<wrangler>", esbuild: "<esbuild>" },
    root,
  );

  return {
    "vite-build": normalisePermissionFlags(viteArgs, root),
    "wrangler-types": normalisePermissionFlags(wranglerTypesArgs, root),
    "wrangler-dry-run": normalisePermissionFlags(dryRunArgs, root),
  };
}
