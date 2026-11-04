/**
 * Ask the installed Vite what its production build actually targets.
 *
 * Vite owns the mapping from the symbolic `baseline-widely-available` default to
 * concrete browser versions, and that mapping changes between Vite releases.
 * Resolving it through Vite's own API keeps this project free of a copied
 * browser-version table.
 */
import { DiscoveryError } from "./discovery.mjs";
import { resolveViteInvocation } from "../../vite-build.mjs";

/** Read the `build.target` that Vite resolves for a production build. */
export function discoverViteTargets(root) {
  const invocation = resolveViteInvocation(root);
  const script = new URL("./vite-probe.mjs", import.meta.url).pathname;

  const result = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      "--allow-sys",
      `--allow-ffi=${invocation.rolldown}`,
      `--allow-ffi=${invocation.lightningcss}`,
      "--cached-only",
      "--frozen",
      script,
      root,
    ],
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
