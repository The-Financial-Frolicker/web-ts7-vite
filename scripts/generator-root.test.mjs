/**
 * Generator-owned installation roots: resolution, containment and planning.
 *
 * These cases build throwaway project roots (and symlinks), so this suite runs
 * with write access. The invariants it protects:
 *
 *   * the dependency tree lives inside `<project root>/generator/`;
 *   * staging and the replaced tree are its siblings, so the swap is a rename;
 *   * a temporary test-application copy reuses the generator's installation;
 *   * every escape (`..`, sibling prefix, outside the project, the
 *     application-owned subtree, a symlink) is rejected before any mutation.
 */

import assert from "./lib/assert.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import { join } from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";
import {
  GENERATOR_PREVIOUS,
  GENERATOR_STAGING_PREFIX,
  GENERATOR_SUBROOT,
  GENERATOR_TOOLCHAIN,
  generatorInstallationRoot,
  generatorInstallationRootPath,
  generatorPreviousPath,
  generatorProjectRoot,
  generatorStagingPath,
  generatorSubrootPath,
  RuntimePolicyError,
} from "./lib/toolchain/runtime.mjs";
import {
  ContainmentError,
  isContained,
  isStrictlyContained,
  requireContained,
} from "./lib/toolchain/containment.mjs";
import { planInstallation } from "./toolchain-install.mjs";

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeEnv(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get: (name) => map.get(name),
    toObject: () => Object.fromEntries(map),
  };
}

/** A project root carrying the pinned-Deno projection the resolvers read. */
function makeProject() {
  const root = Deno.realPathSync(
    mkdtempSync(join(os.tmpdir(), "generator-roots-")),
  );
  temporaryRoots.push(root);
  writeFileSync(
    join(root, ".mise.toml"),
    `[tools]\ndeno = "${Deno.version.deno}"\n`,
  );
  return root;
}

/** Either error type is a correct rejection: containment or runtime policy. */
function expectRejected(fn, label) {
  assert.throws(
    fn,
    (error) =>
      error instanceof ContainmentError || error instanceof RuntimePolicyError,
    `${label} must be rejected`,
  );
}

describe("generator-owned installation roots", () => {
  it("defaults to <project root>/generator/toolchain", () => {
    const root = makeProject();
    assert.equal(
      generatorInstallationRootPath(root, fakeEnv()),
      join(root, GENERATOR_SUBROOT, GENERATOR_TOOLCHAIN),
    );
    assert.equal(
      generatorSubrootPath(root, fakeEnv()),
      join(root, GENERATOR_SUBROOT),
    );
    assert.equal(generatorProjectRoot(root, fakeEnv()), root);
  });

  it("keeps staging and the replaced tree beside the installation", () => {
    const root = makeProject();
    const plan = planInstallation({
      projectRoot: root,
      env: fakeEnv(),
      pid: 4242,
    });

    assert.equal(
      plan.target,
      join(root, GENERATOR_SUBROOT, GENERATOR_TOOLCHAIN),
    );
    assert.equal(
      plan.staging,
      join(root, GENERATOR_SUBROOT, `${GENERATOR_STAGING_PREFIX}4242`),
    );
    assert.equal(
      plan.previous,
      join(root, GENERATOR_SUBROOT, GENERATOR_PREVIOUS),
    );
    assert.equal(generatorStagingPath(root, fakeEnv(), 4242), plan.staging);
    assert.equal(generatorPreviousPath(root, fakeEnv()), plan.previous);

    // One parent means one filesystem, so the final swap is a rename.
    for (const path of [plan.target, plan.staging, plan.previous]) {
      assert.equal(path.slice(0, path.lastIndexOf("/")), plan.subroot);
    }
  });

  it("resolves a temporary copy to the generator's installation", () => {
    const generator = makeProject();
    const copy = makeProject();
    const env = fakeEnv({ GENERATOR_PROJECT_ROOT: generator });

    const fromCopy = generatorInstallationRootPath(copy, env);
    assert.equal(
      fromCopy,
      join(generator, GENERATOR_SUBROOT, GENERATOR_TOOLCHAIN),
    );
    assert.ok(!isContained(fromCopy, copy), "the copy must not own a tree");
    assert.equal(generatorInstallationRootPath(generator, env), fromCopy);
  });

  it("accepts a contained override and rejects every escape", () => {
    const root = makeProject();
    const inside = join(root, GENERATOR_SUBROOT, "custom-tree");
    assert.equal(
      generatorInstallationRootPath(root, fakeEnv({ GENERATOR_ROOT: inside })),
      inside,
    );

    const rejected = {
      "parent traversal": join(root, GENERATOR_SUBROOT, "..", "escape"),
      "sibling prefix": join(
        root,
        `${GENERATOR_SUBROOT}-other`,
        "dependencies",
      ),
      "outside the project": join(root, "..", "elsewhere", "dependencies"),
      "the application-owned root": join(root, "application", "dependencies"),
      "the subroot itself": join(root, GENERATOR_SUBROOT),
      "a relative path": "generator/toolchain",
      "an empty path": "",
    };

    for (const [label, candidate] of Object.entries(rejected)) {
      expectRejected(
        () =>
          generatorInstallationRootPath(
            root,
            fakeEnv({ GENERATOR_ROOT: candidate }),
          ),
        label,
      );
    }
  });

  it("rejects a symlinked component that leaves the subroot", () => {
    const root = makeProject();
    const outside = makeProject();
    const subroot = join(root, GENERATOR_SUBROOT);
    mkdirSync(subroot, { recursive: true });
    symlinkSync(outside, join(subroot, "link"));

    expectRejected(
      () =>
        generatorInstallationRootPath(
          root,
          fakeEnv({ GENERATOR_ROOT: join(subroot, "link", "dependencies") }),
        ),
      "a symlinked component pointing outside",
    );
  });

  it("rejects a symlink at the final installation path", () => {
    const root = makeProject();
    const outside = makeProject();
    const subroot = join(root, GENERATOR_SUBROOT);
    mkdirSync(subroot, { recursive: true });
    symlinkSync(outside, join(subroot, GENERATOR_TOOLCHAIN));

    expectRejected(
      () => generatorInstallationRootPath(root, fakeEnv()),
      "a symlinked installation root",
    );
  });

  it("compares containment without prefix confusion", () => {
    const root = makeProject();
    const subroot = join(root, GENERATOR_SUBROOT);

    assert.ok(isContained(subroot, subroot), "a root contains itself");
    assert.ok(isStrictlyContained(join(subroot, "dependencies"), subroot));
    assert.ok(!isStrictlyContained(subroot, subroot));
    assert.ok(!isContained(join(root, `${GENERATOR_SUBROOT}-other`), subroot));
    assert.ok(!isContained(join(root, "application"), subroot));
    assert.throws(
      () =>
        requireContained(join(root, `${GENERATOR_SUBROOT}-other`), subroot, {
          strict: true,
        }),
      ContainmentError,
    );
  });

  it("plans without touching disk and fails closed before any mutation", () => {
    const root = makeProject();
    const before = [...Deno.readDirSync(root)].map((entry) => entry.name)
      .sort();

    const plan = planInstallation({
      projectRoot: root,
      env: fakeEnv(),
      pid: 7,
    });
    assert.equal(
      plan.target,
      join(root, GENERATOR_SUBROOT, GENERATOR_TOOLCHAIN),
    );
    assert.deepEqual(
      [...Deno.readDirSync(root)].map((entry) => entry.name).sort(),
      before,
      "planning must not create anything",
    );
    assert.equal(existsSync(join(root, GENERATOR_SUBROOT)), false);

    expectRejected(
      () =>
        planInstallation({
          projectRoot: root,
          env: fakeEnv({
            GENERATOR_ROOT: join(root, "application", "dependencies"),
          }),
          pid: 7,
        }),
      "a plan targeting the application root",
    );
    assert.equal(
      existsSync(join(root, GENERATOR_SUBROOT)),
      false,
      "a rejected plan must not create the subroot",
    );
  });

  it("reports an absent installation instead of guessing", () => {
    const root = makeProject();
    assert.throws(
      () => generatorInstallationRoot(root, fakeEnv()),
      /generator installation is not installed at .*toolchain/,
    );
  });
});
