/**
 * Deployment dependency provisioning: the sibling of `toolchain:install`.
 *
 *   deno task deployment:install                    materialise from the lock
 *   deno task deployment:install --seed-from DIR    adopt an already-materialised tree
 *   deno task deployment:install --print            report the resolved target only
 *
 * The two operations have the same contract and different closures:
 *
 *   toolchain:install   `toolchain/`   Vite, Wrangler, TypeScript and the
 *                                      Cloudflare Vite plugin — everything the
 *                                      qualified build and its qualification
 *                                      checks need.
 *   deployment:install  `deployment/`  Wrangler and the Cloudflare Vite plugin —
 *                                      the runtime and package graphs the
 *                                      deployment path and B5 resolve, and
 *                                      nothing else.
 *
 * Both stage, validate, record and swap the same way, in separate trees:
 * `generator/toolchain` (the mise view) and `generator/deployment` are siblings
 * generator-owned subroot, so installing one cannot mutate the other.
 *
 * Why the Cloudflare Vite plugin is a deployment dependency at all: B5 compares
 * the workerd runtime the *Wrangler* graph selects with the one the *plugin*
 * graph selects. The plugin is therefore part of the check, and its package
 * manifest has to be installed for the comparison to resolve. Vite arrives with
 * it as the plugin's peer dependency; nothing on the deployment path imports it,
 * and the specification below does not declare it.
 *
 * Vite, TypeScript, Emscripten, CMake and Ninja are deliberately absent from
 * this closure. The build needs them; deployment does not.
 */

import { join } from "./lib/path.mjs";
import { readFileSync } from "./lib/fs.mjs";
import {
  assertDenoVersion,
  DEPLOYMENT_RECORD,
  deploymentInstallationRootPath,
  deploymentPreviousPath,
  deploymentStagingPath,
  generatorProjectRoot,
  generatorSubrootPath,
} from "./lib/toolchain/runtime.mjs";
import { readToolchainTuple } from "./contracts/toolchain.mjs";
import { assertDeploymentRuntime } from "./lib/cloudflare/deployment-runtime.mjs";
import {
  digestOfFiles,
  fileDigest,
  treeDigest,
} from "./lib/toolchain/tree-digest.mjs";
import { TOOLCHAIN_VIEW } from "./toolchain-install.mjs";
import {
  assertToolchainBoundary,
  copyTree,
  findInstalledPackage,
  installedVersions,
  lockedVersions,
  npmToolchainMembers,
} from "./toolchain-install.mjs";

/** The specification directory, beside `toolchain/`. */
export const DEPLOYMENT_SOURCE = "deployment";

/** The packages the deployment path resolves by name. */
export const REQUIRED_PACKAGES = Object.freeze([
  "wrangler",
  "@cloudflare/vite-plugin",
]);

/**
 * Files that must exist in a complete deployment tree, expressed per package and
 * resolved the way the launchers resolve packages — through the flat entry or the
 * content-addressed store, never by assuming one layout.
 */
export const REQUIRED_FILES = Object.freeze([
  { package: "wrangler", file: "wrangler-dist/cli.js" },
]);

/**
 * Packages that must not appear in this closure at all.
 *
 * TypeScript is the build's type checker and has no deployment role. Its absence
 * is asserted rather than assumed, so a future dependency cannot quietly drag the
 * build toolchain into the deployment tree.
 */
export const FORBIDDEN_PACKAGES = Object.freeze(["typescript"]);

const SOURCE_FILES = Object.freeze(["package.json", "deno.json", "deno.lock"]);

function fail(message) {
  throw new Error(`deployment:install: ${message}`);
}

/** Remove a path when present; absence is not an error. */
function removeIfPresent(path) {
  try {
    Deno.removeSync(path, { recursive: true });
  } catch {
    // Nothing to remove.
  }
}

/** Move a directory when possible, copy otherwise. */
function moveTree(source, target) {
  try {
    Deno.renameSync(source, target);
  } catch {
    copyTree(source, target);
    Deno.removeSync(source, { recursive: true });
  }
}

/**
 * Resolve every path the installation will touch, with containment enforced.
 *
 * Pure, exactly like the toolchain counterpart: a rejected override fails before
 * anything is created.
 */
export function planInstallation({
  projectRoot = Deno.cwd(),
  env = Deno.env,
  pid = Deno.pid,
} = {}) {
  const generatorProject = generatorProjectRoot(projectRoot, env);
  const subroot = generatorSubrootPath(projectRoot, env);
  const target = deploymentInstallationRootPath(projectRoot, env);
  const staging = deploymentStagingPath(projectRoot, env, pid);
  const previous = deploymentPreviousPath(projectRoot, env);

  const toolchainRoot = join(subroot, TOOLCHAIN_VIEW);
  for (
    const [label, candidate] of [
      ["the staging directory", staging],
      ["the previous installation path", previous],
      ["the installation root", target],
    ]
  ) {
    if (candidate === toolchainRoot) {
      fail(
        `${label} must never be the toolchain installation ${toolchainRoot}`,
      );
    }
  }

  return {
    generatorProjectRoot: generatorProject,
    subroot,
    target,
    staging,
    previous,
    toolchainRoot,
  };
}

/**
 * Validate a staged deployment closure and return the installed versions.
 *
 * Four questions, all of them about the closure itself:
 *
 *   1. are the packages the deployment path resolves by name present?
 *   2. is the Wrangler CLI the launchers execute present?
 *   3. are packages that must not be here genuinely absent?
 *   4. do the two workerd graphs agree — the same check B5 performs at the
 *      deployment boundary, so an installation that validates is one B5 accepts?
 */
export function validateStaging(staging) {
  const nodeModules = join(staging, "node_modules");
  // `findInstalledPackage` is shared with the toolchain installer and names that
  // operation in its failure; restate it in this operation's terms.
  const locate = (name) => {
    try {
      return findInstalledPackage(nodeModules, name);
    } catch (error) {
      return fail(
        `${name} is missing from the deployment closure (${error.message})`,
      );
    }
  };

  const installed = {};
  for (const name of REQUIRED_PACKAGES) {
    const dir = locate(name);
    installed[name] =
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
        .version;
  }

  for (const { package: name, file } of REQUIRED_FILES) {
    const path = join(locate(name), file);
    try {
      if (!Deno.statSync(path).isFile) fail(`${path} is not a file`);
    } catch (error) {
      fail(`staged deployment closure is incomplete: ${error.message}`);
    }
  }

  for (const name of FORBIDDEN_PACKAGES) {
    const present = installedVersions(nodeModules, [name])[name] ?? [];
    if (present.length > 0) {
      fail(
        `${name} ${
          present.join(", ")
        } is installed in the deployment closure, ` +
          `but it is a build-only package and has no deployment role`,
      );
    }
  }

  // The same policy the deployment boundary applies, evaluated against the tree
  // that is about to become the installation. `assertDeploymentRuntime` takes
  // the installation root and resolves `node_modules` beneath it — the same
  // convention the launchers use with `policy.deploymentInstallationRoot`.
  const runtime = assertDeploymentRuntime({ nodeModules: staging });

  return { installed, runtime };
}

/** Fail unless the specification declares exactly the deployment set, pinned. */
export function assertDeclaredClosure(declared) {
  const names = Object.keys(declared).sort();
  const required = [...REQUIRED_PACKAGES].sort();

  if (names.join(",") !== required.join(",")) {
    fail(
      `the deployment specification declares ${
        JSON.stringify(names)
      }, but the ` +
        `deployment closure is exactly ${JSON.stringify(required)}`,
    );
  }
  for (const [name, version] of Object.entries(declared)) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      fail(
        `${name} is declared as ${
          JSON.stringify(version)
        }; deployment packages are specified exactly`,
      );
    }
  }
  return declared;
}

/** CLI entry point; returns an exit code. */
export async function main(
  argv = Deno.args,
  appRoot = Deno.cwd(),
  env = Deno.env,
  io = console,
) {
  try {
    const seedIndex = argv.indexOf("--seed-from");
    const seedFrom = seedIndex === -1 ? undefined : argv[seedIndex + 1];

    const plan = planInstallation({ projectRoot: appRoot, env });
    const { target, staging, previous } = plan;

    if (argv.includes("--print")) {
      io.log(JSON.stringify({ ...plan, seedFrom: seedFrom ?? null }, null, 2));
      return 0;
    }

    // 1. Definitions and pins.
    const deno = assertDenoVersion(appRoot);
    const sourceDir = join(appRoot, DEPLOYMENT_SOURCE);
    const texts = {};
    for (const name of SOURCE_FILES) {
      texts[name] = readFileSync(join(sourceDir, name), "utf8");
    }
    const declared = assertDeclaredClosure(
      JSON.parse(texts["package.json"]).dependencies ?? {},
    );

    // 2. Staging: a sibling of the deployment tree, inside the same subroot.
    removeIfPresent(staging);
    Deno.mkdirSync(staging, { recursive: true });
    for (const name of SOURCE_FILES) {
      Deno.writeTextFileSync(join(staging, name), texts[name]);
    }

    // 3. Materialise from the lock, or adopt an existing tree.
    if (seedFrom !== undefined) {
      moveTree(seedFrom, join(staging, "node_modules"));
    } else {
      const allowDownload = argv.includes("--allow-download");
      const result = new Deno.Command(Deno.execPath(), {
        args: [
          "install",
          "--frozen",
          ...(allowDownload ? [] : ["--cached-only"]),
        ],
        cwd: staging,
        stdout: "inherit",
        stderr: "inherit",
        stdin: "null",
      }).outputSync();
      if (result.code !== 0) {
        fail(
          "`deno install --frozen` failed in staging; the locked deployment " +
            "artefacts are not available. Provisioning never resolves or upgrades.",
        );
      }
    }

    // 4. Validate before recording anything.
    const { installed, runtime } = validateStaging(staging);

    // The same tuple boundary the toolchain installer applies: a deployment
    // closure may not carry a different version of a tuple member than the one
    // the toolchain pins, or the deployed artefact and the qualified build could
    // disagree about which Wrangler ran.
    const tuple = readToolchainTuple(appRoot);
    const boundary = assertToolchainBoundary({
      tuple,
      manifest: declared,
      inventory: installedVersions(
        join(staging, "node_modules"),
        Object.keys(npmToolchainMembers(tuple)),
      ),
    });

    const lock = lockedVersions(texts["deno.lock"]);
    for (const name of REQUIRED_PACKAGES) {
      const record = lock[name];
      if (record === undefined) continue;
      const resolved = record.split("_")[0];
      if (resolved !== installed[name]) {
        fail(
          `${name} resolved ${
            installed[name]
          } but the lock records ${resolved}`,
        );
      }
    }

    // 5. Identity, written last.
    const materialisation = await treeDigest(join(staging, "node_modules"));
    const identity = {
      schema: 1,
      role: "deployment",
      deno,
      platform: `${Deno.build.os}-${Deno.build.arch}`,
      spec: await digestOfFiles([
        {
          name: "package.json",
          digest: await fileDigest(join(staging, "package.json")),
        },
        {
          name: "deno.json",
          digest: await fileDigest(join(staging, "deno.json")),
        },
      ]),
      resolution: await fileDigest(join(staging, "deno.lock")),
      materialisation: materialisation.digest,
      implementation: materialisation.implementationDigest,
      metadata: {
        files: materialisation.metadataFiles,
        digest: materialisation.metadataDigest,
      },
      packages: installed,
      // The runtime evidence B5 requires, recorded by the installation that
      // satisfies it.
      runtime: {
        workerd: runtime.workerdVersion,
        platformPackage: runtime.platformPackage,
      },
    };
    Deno.writeTextFileSync(
      join(staging, DEPLOYMENT_RECORD),
      `${JSON.stringify(identity, null, 2)}\n`,
    );

    // 6. Swap: one installation, no history, inside the generator subroot.
    removeIfPresent(previous);
    let hadPrevious = false;
    try {
      Deno.renameSync(target, previous);
      hadPrevious = true;
    } catch {
      // First provision.
    }
    Deno.renameSync(staging, target);
    if (hadPrevious) removeIfPresent(previous);

    io.log(`deployment: installed ${target}`);
    io.log(`deployment: deno=${deno} packages=${JSON.stringify(installed)}`);
    io.log(
      `deployment: runtime workerd=${runtime.workerdVersion} ` +
        `(${runtime.platformPackage}), graphs ${runtime.graphs.join(" + ")}`,
    );
    for (const member of boundary) {
      io.log(
        `deployment: boundary ${member.name}@${member.version} ` +
          `(declared ${member.declared ?? "not a dependency"}, ` +
          `${member.copies} copy(ies), tuple-authorised)`,
      );
    }
    io.log(`deployment: materialisation=${materialisation.digest}`);
    return 0;
  } catch (error) {
    io.error(`deployment: provisioning failed: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
