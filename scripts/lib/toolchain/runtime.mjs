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
import { absolutePath, isContained, requireContained } from "./containment.mjs";

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
 * Product-owned installation roots.
 *
 * The generator owns exactly one subtree of its project root:
 *
 *   <generator project root>/generator/                  the permitted subtree
 *   <generator project root>/generator/dependencies/     the Deno project tree
 *   <generator project root>/generator/.staging-<pid>/   staging
 *   <generator project root>/generator/.previous/        the replaced tree
 *
 * `GENERATOR_PROJECT_ROOT` names the project root that owns the installation: a
 * temporary test-application copy sets it to the generator checkout so the copy
 * uses the generator's one installation instead of materialising its own.
 * `GENERATOR_ROOT` overrides the dependency tree and is subject to exactly the
 * same containment check as the default, so it is not a route around ownership.
 */
export const GENERATOR_SUBROOT = "generator";
export const GENERATOR_DEPENDENCIES = "dependencies";
export const GENERATOR_STAGING_PREFIX = ".staging-";
export const GENERATOR_PREVIOUS = ".previous";
export const APPLICATION_SUBROOT = "application";
export const GENERATOR_PROJECT_ROOT_VARIABLE = "GENERATOR_PROJECT_ROOT";
export const GENERATOR_ROOT_VARIABLE = "GENERATOR_ROOT";

/** The real project root that owns the installation. */
export function generatorProjectRoot(projectRoot = Deno.cwd(), env = Deno.env) {
  const override = env.get(GENERATOR_PROJECT_ROOT_VARIABLE);
  // Unset means "this project root"; set-but-empty is an invalid override and
  // is rejected rather than silently replaced by the default.
  const chosen = override === undefined
    ? absolutePath(projectRoot, "the project root")
    : absolutePath(override, GENERATOR_PROJECT_ROOT_VARIABLE);

  return realDirectory(chosen, "generator project root");
}

/** The generator-owned subtree; nothing may be installed outside it. */
export function generatorSubrootPath(projectRoot = Deno.cwd(), env = Deno.env) {
  return join(generatorProjectRoot(projectRoot, env), GENERATOR_SUBROOT);
}

/**
 * The application-owned subtree, named only so a generator installation that
 * targets it can be refused with a legible message. The generator never owns or
 * creates it; the symmetric rule belongs to the independent application.
 */
export function applicationSubrootPath(
  projectRoot = Deno.cwd(),
  env = Deno.env,
) {
  return join(generatorProjectRoot(projectRoot, env), APPLICATION_SUBROOT);
}

/** Containment check shared by every generator-owned installation path. */
function ownedInstallationPath(
  candidate,
  projectRoot,
  env,
  candidateLabel,
  strict,
) {
  const subroot = generatorSubrootPath(projectRoot, env);
  const application = applicationSubrootPath(projectRoot, env);

  if (isContained(candidate, application)) {
    fail(
      `${candidateLabel} ${candidate} targets the application-owned root; the ` +
        `generator may only install inside ${subroot}`,
    );
  }

  return requireContained(candidate, subroot, {
    candidateLabel,
    permittedLabel: "the generator-owned subroot",
    strict,
    hint: `the generator installation must stay inside ${subroot}`,
  });
}

/**
 * The generator's Deno dependency tree.
 *
 * The default is a child of the generator-owned subroot; an override must be a
 * strict child of the same subroot, so the tree can never be the subroot itself
 * (staging and the replaced tree are its siblings) and never another product's.
 */
export function generatorInstallationRootPath(
  projectRoot = Deno.cwd(),
  env = Deno.env,
) {
  const subroot = generatorSubrootPath(projectRoot, env);
  const override = env.get(GENERATOR_ROOT_VARIABLE);
  const candidate = override === undefined
    ? join(subroot, GENERATOR_DEPENDENCIES)
    : absolutePath(override, GENERATOR_ROOT_VARIABLE);

  return ownedInstallationPath(
    candidate,
    projectRoot,
    env,
    `the ${GENERATOR_ROOT_VARIABLE} installation root`,
    true,
  );
}

/** Staging directory: a sibling of the dependency tree, inside the subroot. */
export function generatorStagingPath(
  projectRoot = Deno.cwd(),
  env = Deno.env,
  pid = Deno.pid,
) {
  const subroot = generatorSubrootPath(projectRoot, env);
  return ownedInstallationPath(
    join(subroot, `${GENERATOR_STAGING_PREFIX}${pid}`),
    projectRoot,
    env,
    "the staging directory",
    true,
  );
}

/** The replaced installation: a sibling of the dependency tree, in the subroot. */
export function generatorPreviousPath(
  projectRoot = Deno.cwd(),
  env = Deno.env,
) {
  const subroot = generatorSubrootPath(projectRoot, env);
  return ownedInstallationPath(
    join(subroot, GENERATOR_PREVIOUS),
    projectRoot,
    env,
    "the previous installation path",
    true,
  );
}

/** The installed dependency tree, required to exist as a real directory. */
export function generatorInstallationRoot(
  projectRoot = Deno.cwd(),
  env = Deno.env,
) {
  return realDirectory(
    generatorInstallationRootPath(projectRoot, env),
    "generator installation",
  );
}

/** The installation record, written last by provisioning. */
export function installedIdentity(root) {
  const path = join(root, "toolchain.json");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(
      `${root} is not a complete generator installation (${error.message}). ` +
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
 * canonical generator installation root, and an installation whose recorded
 * identity matches this runtime.
 */
export function runtimePolicy(
  projectRoot = Deno.cwd(),
  running = Deno.version.deno,
  env = Deno.env,
) {
  const deno = assertDenoVersion(projectRoot, running);
  const root = generatorInstallationRoot(projectRoot, env);
  const identity = installedIdentity(root);

  if (identity.deno !== deno) {
    fail(
      `the installed generator dependencies were provisioned for Deno ` +
        `${identity.deno}, but this process is Deno ${deno}. Re-provision with ` +
        `\`deno task toolchain:install\`.`,
    );
  }

  return { deno, generatorInstallationRoot: root, identity };
}
