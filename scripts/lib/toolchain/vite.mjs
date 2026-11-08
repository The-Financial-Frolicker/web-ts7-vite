/**
 * Ask the installed Vite what its production build actually targets.
 *
 * Vite owns the mapping from the symbolic `baseline-widely-available` default to
 * concrete browser versions, and that mapping changes between Vite releases.
 * Resolving it through Vite's own API keeps this project free of a copied
 * browser-version table.
 *
 * The child process runs under one of the named profiles declared beside the
 * build profiles in `scripts/vite-build.mjs` — `local` (restricted, the default)
 * or `ci-runner` (`--allow-all`, selected explicitly on a hosted CI runner).
 * Vite's platform detection probes procfs paths that Deno refuses under scoped
 * permissions there (denoland/deno#37062). The profile is passed in; nothing
 * here inspects the host.
 */
import { DiscoveryError } from "./discovery.mjs";
import { generatorInstallationRoot } from "./runtime.mjs";
import {
  buildViteProbeArgs,
  DEFAULT_VITE_PROBE_PROFILE,
  resolveViteInvocation,
} from "../../vite-build.mjs";

/** Read the `build.target` that Vite resolves for a production build. */
export function discoverViteTargets(
  root,
  { profile = DEFAULT_VITE_PROBE_PROFILE } = {},
) {
  const invocation = resolveViteInvocation(generatorInstallationRoot());
  const script = `${generatorInstallationRoot()}/scripts/vite-probe.mjs`;

  const result = new Deno.Command(Deno.execPath(), {
    args: buildViteProbeArgs(invocation, script, root, profile),
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();

  const stderr = new TextDecoder().decode(result.stderr);
  if (result.code !== 0) {
    throw new DiscoveryError(
      `could not resolve Vite's production target: ${stderr.trim()}`,
    );
  }

  const [line] = new TextDecoder().decode(result.stdout).trim().split("\n");
  try {
    const parsed = JSON.parse(line);
    return { version: parsed.version, targets: parsed.target };
  } catch {
    throw new DiscoveryError(
      `Vite's production target could not be read from '${line ?? ""}'`,
    );
  }
}
