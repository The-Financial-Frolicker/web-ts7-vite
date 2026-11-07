/**
 * Toolchain runtime policy and installed-toolchain location.
 *
 * One authoritative resolver for the external installation, one Deno-pin
 * assertion, and one check that the installation is complete. Every launcher
 * uses these; none of them re-derives a path.
 *
 * The installation root is resolved to its canonical physical path because Deno
 * compares `--allow-ffi` and `--allow-run` grants against real paths, and
 * because a symlinked installation would let a grant point somewhere else.
 */

import { join } from "../path.mjs";
import { readFileSync } from "../fs.mjs";

export class RuntimePolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimePolicyError";
  }
}

function fail(message) {
  throw new RuntimePolicyError(message);
}

/**
 * Approved Deno version from the `[tools]` table of the application's
 * `.mise.toml`, which the generator owns and every product inherits.
 */
export function pinnedDenoVersion(appRoot) {
  let text;
  try {
    text = readFileSync(join(appRoot, ".mise.toml"), "utf8");
  } catch (error) {
    fail(
      `cannot read ${
        join(appRoot, ".mise.toml")
      }; the toolchain pin is unknown ` +
        `(${error.message})`,
    );
  }

  let inTools = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inTools = line === "[tools]";
      continue;
    }
    if (!inTools || line.length === 0 || line.startsWith("#")) continue;

    const entry = /^deno\s*=\s*"([^"]+)"$/.exec(line);
    if (entry !== null) return entry[1];
  }

  fail(
    `${join(appRoot, ".mise.toml")} pins no \`deno\` version; run ` +
      `\`deno task toolchain:prepare --write\``,
  );
}

/** Fail unless the running interpreter is the pinned one. */
export function assertDenoVersion(appRoot, running = Deno.version.deno) {
  const pinned = pinnedDenoVersion(appRoot);
  if (pinned === running) return pinned;

  fail(
    `this project pins Deno ${pinned}, but this process is Deno ${running}. ` +
      `Run the task through the pinned toolchain (\`mise install\`, then ` +
      `\`mise exec -- …\`), or move the pin deliberately and review the diff.`,
  );
}

/** Require a real, canonical directory at `path`. */
function realDirectory(path, label) {
  let stat;
  try {
    stat = Deno.lstatSync(path);
  } catch (error) {
    fail(
      `${label} is not installed at ${path} (${error.message}). Provision it ` +
        `with \`deno task toolchain:install\`.`,
    );
  }

  if (stat.isSymlink) {
    fail(`${path} is a symlink; a ${label} must be a real directory`);
  }
  if (!stat.isDirectory) fail(`${path} is not a directory`);

  try {
    return Deno.realPathSync(path);
  } catch (error) {
    fail(`cannot resolve ${path}: ${error.message}`);
  }
}

/**
 * The configured installation path, without requiring it to exist.
 *
 * `TOOLCHAIN_ROOT` when set, otherwise `$XDG_DATA_HOME/web-ts7-vite/toolchain`
 * with the standard XDG default. Provisioning needs the path before the
 * directory exists; resolution needs it checked — both use this one rule.
 */
export function toolchainRootPath(env = Deno.env) {
  const override = env.get("TOOLCHAIN_ROOT");
  if (override !== undefined && override !== "") return override;

  const xdg = env.get("XDG_DATA_HOME");
  const home = env.get("HOME");
  const base = xdg !== undefined && xdg !== ""
    ? xdg
    : home === undefined || home === ""
    ? undefined
    : join(home, ".local", "share");

  if (base === undefined) {
    fail(
      "cannot determine the toolchain installation root; set TOOLCHAIN_ROOT " +
        "or XDG_DATA_HOME",
    );
  }

  return join(base, "web-ts7-vite", "toolchain");
}

/** The installed toolchain root, required to exist as a real directory. */
export function toolchainRoot(env = Deno.env) {
  return realDirectory(toolchainRootPath(env), "toolchain installation");
}

/** The installation record, written last by provisioning. */
export function installedIdentity(root) {
  const path = join(root, "toolchain.json");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(
      `${root} is not a complete toolchain installation (${error.message}). ` +
        `A refresh may have failed; re-run \`deno task toolchain:install\`.`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`);
  }
}

/**
 * Everything a launcher needs before it does any work: the pinned Deno, the
 * canonical installation root, and an installation whose recorded identity
 * matches this runtime.
 */
export function runtimePolicy(
  appRoot,
  running = Deno.version.deno,
  env = Deno.env,
) {
  const deno = assertDenoVersion(appRoot, running);
  const root = toolchainRoot(env);
  const identity = installedIdentity(root);

  if (identity.deno !== deno) {
    fail(
      `the installed toolchain was provisioned for Deno ${identity.deno}, but ` +
        `this process is Deno ${deno}. Re-provision with ` +
        `\`deno task toolchain:install\`.`,
    );
  }

  return { deno, toolchainRoot: root, identity };
}
