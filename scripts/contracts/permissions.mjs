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
  buildViteProbeArgs,
  DEFAULT_VITE_PERMISSION_PROFILE,
  DEFAULT_VITE_PROBE_PROFILE,
  VITE_PERMISSION_PROFILES,
  VITE_PROBE_PROFILES,
} from "../vite-build.mjs";
import {
  buildViteServerArgs,
  SERVER_PORTS,
  VITE_SERVER_MODES,
} from "../vite-server.mjs";
import { buildWranglerDeployArgs } from "../wrangler-deploy.mjs";
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
 * Contract key for one named profile; the default profile keeps the base name.
 *
 * Deriving the keys from the launcher's profile list means a profile cannot be
 * added or renamed without changing the policy.
 */
function profileKey(base, profile, defaultProfile) {
  return profile === defaultProfile ? base : `${base}-${profile}`;
}

/**
 * Build the declared profile of every external-tool launcher.
 *
 * Synthetic invocation values are used for the Vite profile: only the declared
 * permission flags are compared, so no resolution or execution is involved.
 */
export function describePermissionProfiles(
  root = Deno.cwd(),
  generatorInstallationRoot = root,
) {
  const viteInvocation = {
    viteBin: "<vite>",
    runner: join(generatorInstallationRoot, "scripts", "vite-runner.mjs"),
    rolldown: "<rolldown>",
    lightningcss: "<lightningcss>",
    // The plugin's own installation resolves its own copies of the same two
    // native bindings, so the build and server profiles declare two further
    // path-scoped grants. The probe imports Vite only, so it keeps just the
    // view's two.
    ffi: [
      "<rolldown>",
      "<lightningcss>",
      "<plugin-rolldown>",
      "<plugin-lightningcss>",
    ],
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
      profileKey("vite-build", profile, DEFAULT_VITE_PERMISSION_PROFILE),
      normalisePermissionFlags(
        buildViteArgs(viteInvocation, [], profile),
        root,
      ),
    ]),
  );

  // The production-target probe is Vite too, and its declared requirement is
  // recorded the same way, so a widened probe cannot pass unreviewed.
  const viteProbeProfiles = Object.fromEntries(
    VITE_PROBE_PROFILES.map((profile) => [
      profileKey("vite-probe", profile, DEFAULT_VITE_PROBE_PROFILE),
      normalisePermissionFlags(
        buildViteProbeArgs(viteInvocation, "<vite-probe>", "<root>", profile),
        root,
      ),
    ]),
  );

  // Development and preview servers: one recorded profile per mode, so the
  // requirement names the port whose wildcard probe Vite performs.
  const viteServerProfiles = Object.fromEntries(
    VITE_SERVER_MODES.map((mode) => [
      `vite-${mode}`,
      normalisePermissionFlags(
        buildViteServerArgs(
          {
            runner: join(
              generatorInstallationRoot,
              "scripts",
              "vite-runner.mjs",
            ),
            appRoot: root,
            rolldown: "<rolldown>",
            lightningcss: "<lightningcss>",
            ffi: [
              "<rolldown>",
              "<lightningcss>",
              "<plugin-rolldown>",
              "<plugin-lightningcss>",
            ],
            workerd: "<workerd>",
          },
          mode,
          SERVER_PORTS[mode],
        ),
        root,
      ),
    ]),
  );

  // Deployment: Wrangler under Deno, one API host, esbuild to bundle.
  const deployArgs = buildWranglerDeployArgs({
    wranglerCli: "<wrangler>",
    esbuild: "<esbuild>",
    appRoot: root,
    config: join(root, "dist", "worker", "wrangler.json"),
  });

  return {
    ...viteProfiles,
    ...viteProbeProfiles,
    ...viteServerProfiles,
    "wrangler-types": normalisePermissionFlags(wranglerTypesArgs, root),
    "wrangler-dry-run": normalisePermissionFlags(dryRunArgs, root),
    "wrangler-deploy": normalisePermissionFlags(deployArgs, root),
    "edge-verify": normalisePermissionFlags(edgeVerifyArgs, root),
  };
}
