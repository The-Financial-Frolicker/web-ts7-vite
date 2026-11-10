/**
 * Tests for the mise-owned toolchain resolution mechanism.
 *
 * The fixtures are synthetic stores, so the assertions test the *logic* the
 * resolver depends on and not the current machine's layout: identity from
 * `package.json`, dependencies reached through symlinks, scoped packages, the
 * traversal bound, version conflicts, manifest-driven native bindings and a
 * symlink-only view.
 */
import assert from "../assert.mjs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "../fs.mjs";
import os from "../os.mjs";
import path from "../path.mjs";
import { after, describe, it } from "../test.mjs";
import {
  createResolutionView,
  miseDataDirectory,
  nativeBinding,
  packageClosure,
  platformTags,
  resolveMiseTool,
  ToolchainViewError,
} from "./mise.mjs";

const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = Deno.realPathSync(mkdtempSync(path.join(os.tmpdir(), "mise-")));
  roots.push(root);
  return root;
}

/** Create a store entry `store/<pkg>@<ver>/node_modules/<pkg>` and link it. */
function package_(root, store, name, version, { linkAt } = {}) {
  const id = `${name.replace("/", "+")}@${version}`;
  const dir = path.join(root, store, id, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version }),
  );
  if (linkAt !== undefined) {
    mkdirSync(path.dirname(linkAt), { recursive: true });
    Deno.symlinkSync(dir, linkAt);
  }
  return dir;
}

/** Link `name` into the store entry that owns `owner`. */
function depend(root, store, owner, ownerVersion, name, version) {
  const ownerEntry = path.join(
    root,
    store,
    `${owner.replace("/", "+")}@${ownerVersion}`,
    "node_modules",
  );
  const dir = package_(root, store, name, version);
  const link = path.join(ownerEntry, ...name.split("/"));
  mkdirSync(path.dirname(link), { recursive: true });
  Deno.symlinkSync(dir, link);
  return dir;
}

describe("platform tags", () => {
  it("uses npm's names, not Deno's", () => {
    const tags = platformTags();
    assert.match(tags.arch, /^(x64|arm64|ia32|arm)$/);
    assert.match(tags.os, /^(linux|darwin|win32|freebsd)$/);
    assert.match(tags.libc, /^(gnu|musl)$/);
    // Deno says x86_64; npm says x64. The mapping must not leak through.
    assert.doesNotMatch(tags.arch, /_/);
  });
});

describe("package closure", () => {
  it("follows symlinked dependencies (the regression this task fixes)", () => {
    const root = tempRoot();
    const entry = package_(root, "store", "vite", "1.0.0");
    depend(root, "store", "vite", "1.0.0", "rolldown", "2.0.0");

    const closure = packageClosure(entry);
    assert.deepEqual(closure.packages.map((p) => p.name).sort(), [
      "rolldown",
      "vite",
    ]);
    assert.deepEqual(closure.truncated, []);
    assert.deepEqual(closure.conflicts, []);
  });

  it("discovers scoped packages", () => {
    const root = tempRoot();
    const entry = package_(root, "store", "vite", "1.0.0");
    depend(
      root,
      "store",
      "vite",
      "1.0.0",
      "@scope/binding-linux-x64-gnu",
      "3.0.0",
    );

    const closure = packageClosure(entry);
    assert.ok(
      closure.packages.some((p) => p.name === "@scope/binding-linux-x64-gnu"),
    );
  });

  it("reports a version conflict instead of choosing", () => {
    const root = tempRoot();
    const entry = package_(root, "store", "vite", "1.0.0");
    depend(root, "store", "vite", "1.0.0", "shared", "1.0.0");
    depend(root, "store", "vite", "1.0.0", "other", "1.0.0");
    depend(root, "store", "other", "1.0.0", "shared", "2.0.0");

    const closure = packageClosure(entry);
    assert.equal(closure.conflicts.length, 1);
    assert.equal(closure.conflicts[0].name, "shared");
    assert.deepEqual(closure.conflicts[0].versions.sort(), ["1.0.0", "2.0.0"]);
  });

  it("reports a hit traversal bound instead of omitting silently", () => {
    const root = tempRoot();
    const entry = package_(root, "store", "vite", "1.0.0");
    depend(root, "store", "vite", "1.0.0", "dep", "1.0.0");
    depend(root, "store", "dep", "1.0.0", "deep", "1.0.0");

    const closure = packageClosure(entry, { depth: 1 });
    assert.ok(closure.truncated.length > 0, "the bound must be visible");
  });
});

describe("native binding discovery", () => {
  /** A store with an owner package that declares one platform binding. */
  function storeWith(owner, bindingName, addonFile) {
    const root = tempRoot();
    const entry = package_(root, "store", owner, "1.0.0");
    const bindingDir = depend(
      root,
      "store",
      owner,
      "1.0.0",
      bindingName,
      "1.2.3",
    );
    writeFileSync(path.join(bindingDir, addonFile), "not-a-real-addon");
    writeFileSync(
      path.join(entry, "package.json"),
      JSON.stringify({
        name: owner,
        version: "1.0.0",
        optionalDependencies: { [bindingName]: "1.2.3" },
      }),
    );
    return packageClosure(entry);
  }

  it("reads a scoped binding name from the owner's manifest", () => {
    const { os, arch, libc } = platformTags();
    const name = `@scope/binding-${os}-${arch}-${libc}`;
    const binding = nativeBinding(
      storeWith("rolldown", name, "b.node").packages,
      "rolldown",
    );
    assert.equal(binding.package, name);
    assert.match(binding.addon, /b\.node$/);
    assert.equal(Deno.realPathSync(binding.addon), binding.addon);
  });

  it("reads an unscoped binding name from the owner's manifest", () => {
    const { os, arch, libc } = platformTags();
    const name = `lightningcss-${os}-${arch}-${libc}`;
    const binding = nativeBinding(
      storeWith("lightningcss", name, "l.node").packages,
      "lightningcss",
    );
    assert.equal(binding.package, name);
  });

  it("fails when the owner is absent", () => {
    assert.throws(() => nativeBinding([], "rolldown"), ToolchainViewError);
  });

  it("fails when no platform binding is installed", () => {
    const root = tempRoot();
    const entry = package_(root, "store", "rolldown", "1.0.0");
    writeFileSync(
      path.join(entry, "package.json"),
      JSON.stringify({
        name: "rolldown",
        version: "1.0.0",
        optionalDependencies: { "@x/binding-other": "1.0.0" },
      }),
    );
    assert.throws(
      () => nativeBinding(packageClosure(entry).packages, "rolldown"),
      /declares no .* binding that is installed/,
    );
  });
});

describe("resolution view", () => {
  const packages = (root) => [
    {
      name: "vite",
      version: "1.0.0",
      directory: package_(root, "store", "vite", "1.0.0"),
    },
  ];

  it("creates symlinks, never copies", () => {
    const root = tempRoot();
    const view = createResolutionView(path.join(root, "view"), packages(root));
    const link = path.join(view.nodeModules, "vite");
    assert.equal(Deno.lstatSync(link).isSymlink, true);
    assert.equal(
      readFileSync(path.join(link, "package.json"), "utf8").includes("vite"),
      true,
    );
  });

  it("is deterministic and removes links that no longer belong", () => {
    const root = tempRoot();
    const viewRoot = path.join(root, "view");
    createResolutionView(viewRoot, packages(root));
    const stale = path.join(viewRoot, "node_modules", "stale");
    Deno.symlinkSync(path.join(root, "store"), stale);

    const first = createResolutionView(viewRoot, packages(root));
    const second = createResolutionView(viewRoot, packages(root));
    assert.deepEqual(first.links, second.links);
    let removed = false;
    try {
      Deno.lstatSync(stale);
    } catch {
      removed = true;
    }
    assert.equal(
      removed,
      true,
      "a link that no longer belongs must be removed",
    );
  });
});

describe("the real mise installation", () => {
  it("is discovered with its bindings, every path inside mise", () => {
    const data = miseDataDirectory();
    const root = tempRoot();
    const tool = resolveMiseTool({
      name: "vite",
      version: "8.3.5",
      viewRoot: path.join(root, "view"),
      bindings: ["rolldown", "lightningcss"],
    });

    assert.ok(
      tool.installation.startsWith(data),
      "the installation is mise-owned",
    );
    for (const entry of tool.packages) {
      assert.ok(
        entry.directory.startsWith(data),
        `${entry.name} is mise-owned`,
      );
    }
    for (const link of tool.view.links) {
      assert.ok(
        link.target.startsWith(data),
        `${link.path} resolves inside mise`,
      );
    }
    assert.deepEqual(tool.bindings.map((b) => b.owner), [
      "rolldown",
      "lightningcss",
    ]);
    for (const binding of tool.bindings) {
      assert.ok(binding.addon.startsWith(data));
      assert.equal(Deno.realPathSync(binding.addon), binding.addon);
    }
  });
});
