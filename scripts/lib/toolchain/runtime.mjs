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
      `\`deno task toolchain:specify -- --deno <version> …\``,
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
function realDirectory(path, label, provisionHint = "toolchain:install") {
  let stat;
  try {
    stat = Deno.lstatSync(path);
  } catch (error) {
    fail(
      `${label} is not installed at ${path} (${error.message}). Provision it ` +
        `with \`deno task ${provisionHint}\`.`,
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
 *   <generator project root>/generator/toolchain/        the mise-backed view
 *   <generator project root>/generator/deployment/       the deployment closure
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
/**
 * The toolchain view: resolution infrastructure over the mise-owned installation.
 * mise owns the packages; this directory holds symlinks into them and the
 * certificate that records what was installed.
 */
export const GENERATOR_TOOLCHAIN = "toolchain";
export const GENERATOR_STAGING_PREFIX = ".staging-";
export const GENERATOR_PREVIOUS = ".previous";
export const APPLICATION_SUBROOT = "application";
export const GENERATOR_PROJECT_ROOT_VARIABLE = "GENERATOR_PROJECT_ROOT";
export const GENERATOR_ROOT_VARIABLE = "GENERATOR_ROOT";

/**
 * The second installation: the deployment dependency closure.
 *
 * A sibling of the toolchain tree inside the same generator-owned subroot, with
 * its own specification, staging, replaced tree and record. Nothing here changes
 * how the toolchain tree is resolved; the two roots are independent siblings and
 * installing one never touches the other.
 *
 *   <generator project root>/generator/deployment/                 the tree
 *   <generator project root>/generator/.staging-deployment-<pid>/  staging
 *   <generator project root>/generator/.previous-deployment/       the replaced tree
 *
 * `DEPLOYMENT_ROOT` overrides the tree under the same containment rule as
 * `GENERATOR_ROOT`, so an override is not a route around ownership.
 */
export const GENERATOR_DEPLOYMENT = "deployment";
export const DEPLOYMENT_ROOT_VARIABLE = "DEPLOYMENT_ROOT";
export const DEPLOYMENT_STAGING_PREFIX = ".staging-deployment-";
export const DEPLOYMENT_PREVIOUS = ".previous-deployment";

/** The record that marks an installation complete, per installation role. */
export const TOOLCHAIN_RECORD = "toolchain.json";
export const DEPLOYMENT_RECORD = "deployment.json";

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
 * The generator's toolchain view.
 *
 * The default is a child of the generator-owned subroot; an override must be a
 * strict child of the same subroot, so the tree can never be the subroot itself
 * (staging and the replaced tree are its siblings) and never another product's.
 *
 * `GENERATOR_ROOT` keeps naming "the dependency tree this process resolves
 * from". It is the toolchain view now, because the toolchain is no longer
 * installed into a Deno tree.
 */
export function generatorInstallationRootPath(
  projectRoot = Deno.cwd(),
  env = Deno.env,
) {
  const subroot = generatorSubrootPath(projectRoot, env);
  const override = env.get(GENERATOR_ROOT_VARIABLE);
  const candidate = override === undefined
    ? join(subroot, GENERATOR_TOOLCHAIN)
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

/**
 * The deployment dependency tree, under the same ownership rules.
 *
 * A strict child of the generator-owned subroot, never that subroot itself, and
 * never the application's. Installing it is a separate operation from installing
 * the toolchain; resolving one never resolves the other.
 */
export function deploymentInstallationRootPath(
  projectRoot = Deno.cwd(),
  env = Deno.env,
) {
  const subroot = generatorSubrootPath(projectRoot, env);
  const override = env.get(DEPLOYMENT_ROOT_VARIABLE);
  return ownedInstallationPath(
    override === undefined
      ? join(subroot, GENERATOR_DEPLOYMENT)
      : absolutePath(override, DEPLOYMENT_ROOT_VARIABLE),
    projectRoot,
    env,
    `the ${DEPLOYMENT_ROOT_VARIABLE} installation root`,
    true,
  );
}

/** Staging directory for the deployment tree: a sibling, inside the subroot. */
export function deploymentStagingPath(
  projectRoot = Deno.cwd(),
  env = Deno.env,
  pid = Deno.pid,
) {
  const subroot = generatorSubrootPath(projectRoot, env);
  return ownedInstallationPath(
    join(subroot, `${DEPLOYMENT_STAGING_PREFIX}${pid}`),
    projectRoot,
    env,
    "the deployment staging directory",
    true,
  );
}

/** The replaced deployment tree: a sibling, inside the subroot. */
export function deploymentPreviousPath(
  projectRoot = Deno.cwd(),
  env = Deno.env,
) {
  const subroot = generatorSubrootPath(projectRoot, env);
  return ownedInstallationPath(
    join(subroot, DEPLOYMENT_PREVIOUS),
    projectRoot,
    env,
    "the previous deployment installation path",
    true,
  );
}

/** The installed deployment tree, required to exist as a real directory. */
export function deploymentInstallationRoot(
  projectRoot = Deno.cwd(),
  env = Deno.env,
) {
  return realDirectory(
    deploymentInstallationRootPath(projectRoot, env),
    "deployment installation",
    "deployment:install",
  );
}

/**
 * The installation record, written last by provisioning.
 *
 * Each installation role writes its own record inside its own tree, so "is this
 * tree complete?" is answered by the tree itself and never by a directory name.
 */
export function installedIdentity(root, record = TOOLCHAIN_RECORD) {
  const path = join(root, record);
  const provision = record === DEPLOYMENT_RECORD
    ? "deployment:install"
    : "toolchain:install";

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    fail(
      `${root} is not a complete generator installation (${error.message}). ` +
        `A refresh may have failed; re-run \`deno task ${provision}\`.`,
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

/**
 * The deployment counterpart: the same pin assertion, the same record check,
 * resolved against the deployment tree instead of the toolchain tree.
 *
 * Deployment is the only phase that resolves Wrangler, esbuild and the two
 * workerd graphs, so it is the only phase that requires this installation. A
 * build-only environment can satisfy `runtimePolicy` and still have no
 * deployment tree at all.
 */
export function deploymentRuntimePolicy(
  projectRoot = Deno.cwd(),
  running = Deno.version.deno,
  env = Deno.env,
) {
  const deno = assertDenoVersion(projectRoot, running);
  const root = deploymentInstallationRoot(projectRoot, env);
  const identity = installedIdentity(root, DEPLOYMENT_RECORD);

  if (identity.deno !== deno) {
    fail(
      `the installed deployment dependencies were provisioned for Deno ` +
        `${identity.deno}, but this process is Deno ${deno}. Re-provision with ` +
        `\`deno task deployment:install\`.`,
    );
  }

  return { deno, deploymentInstallationRoot: root, identity };
}
