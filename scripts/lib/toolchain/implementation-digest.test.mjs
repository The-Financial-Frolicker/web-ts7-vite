/**
 * Portable implementation identity of the mise-owned toolchain.
 *
 * The certificate's `implementation` digest must describe *package content*, not
 * the place it is installed: two equivalent closures under different absolute
 * roots must produce one identity, and any materially different closure must
 * produce another. These tests use the production digest function; there is no
 * test-only algorithm.
 *
 * What this proves: the digest is invariant under relocation and sensitive to
 * content, mode, versions, inventory and symlink relationships.
 * What it does not prove: cross-machine or cross-distribution equivalence (that
 * needs the authoritative runner), or that a different mise store layout with the
 * same package contents hashes identically — the layout is never hashed, but that
 * claim is only exercised by the real installations.
 */
import assert from "../assert.mjs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "../fs.mjs";
import os from "../os.mjs";
import path from "../path.mjs";
import { after, describe, it } from "../test.mjs";
import { implementationDigest, ToolchainViewError } from "./mise.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function storeRoot(label) {
  const root = Deno.realPathSync(
    mkdtempSync(path.join(os.tmpdir(), `impl-${label}-`)),
  );
  roots.push(root);
  return root;
}

function writeFile(root, relative, contents, { executable = false } = {}) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  if (executable) chmodSync(file, 0o755);
}

/**
 * Two packages with an internal symlink and a package-to-package symlink — the
 * two link shapes the certified closure's policy actually defines.
 */
function buildClosure(
  {
    alphaVersion = "1.0.0",
    alphaBody = "export const alpha = 1;\n",
    executable = true,
    extraPackage = false,
    aliasTarget = "index.js",
    betaLinksAlpha = true,
    externalLink = false,
    brokenLink = false,
  } = {},
  label = "a",
) {
  const root = storeRoot(label);
  const alpha = path.join(
    root,
    "store",
    `alpha@${alphaVersion}`,
    "node_modules",
    "alpha",
  );
  writeFile(
    root,
    `store/alpha@${alphaVersion}/node_modules/alpha/package.json`,
    JSON.stringify({ name: "alpha", version: alphaVersion }),
  );
  writeFile(
    root,
    `store/alpha@${alphaVersion}/node_modules/alpha/index.js`,
    alphaBody,
  );
  writeFile(
    root,
    `store/alpha@${alphaVersion}/node_modules/alpha/other.js`,
    "export const other = 2;\n",
  );
  writeFile(
    root,
    `store/alpha@${alphaVersion}/node_modules/alpha/bin/tool`,
    "#!/bin/sh\n",
    { executable },
  );
  Deno.symlinkSync(aliasTarget, path.join(alpha, "lib-alias"));

  const beta = path.join(root, "store", "beta@2.0.0", "node_modules", "beta");
  writeFile(
    root,
    "store/beta@2.0.0/node_modules/beta/package.json",
    JSON.stringify({ name: "beta", version: "2.0.0" }),
  );
  writeFile(
    root,
    "store/beta@2.0.0/node_modules/beta/index.js",
    "export default 1;\n",
  );
  if (betaLinksAlpha) {
    mkdirSync(path.join(beta, "node_modules"), { recursive: true });
    Deno.symlinkSync(alpha, path.join(beta, "node_modules", "alpha"));
  }
  if (externalLink) {
    const outside = path.join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "payload.js"), "outside\n");
    Deno.symlinkSync(
      path.join(outside, "payload.js"),
      path.join(beta, "external.js"),
    );
  }
  if (brokenLink) {
    Deno.symlinkSync(
      path.join(root, "missing.js"),
      path.join(beta, "broken.js"),
    );
  }
  if (extraPackage) {
    writeFile(
      root,
      "store/gamma@3.0.0/node_modules/gamma/package.json",
      JSON.stringify({ name: "gamma", version: "3.0.0" }),
    );
    writeFile(root, "store/gamma@3.0.0/node_modules/gamma/index.js", "x\n");
  }

  const packages = [
    {
      name: "alpha",
      version: alphaVersion,
      directory: Deno.realPathSync(alpha),
    },
    { name: "beta", version: "2.0.0", directory: Deno.realPathSync(beta) },
  ];
  if (extraPackage) {
    packages.push({
      name: "gamma",
      version: "3.0.0",
      directory: Deno.realPathSync(
        path.join(root, "store", "gamma@3.0.0", "node_modules", "gamma"),
      ),
    });
  }
  return { root, packages };
}

describe("relocation portability", () => {
  it("gives equivalent closures installed under different roots one identity", async () => {
    const first = buildClosure({}, "portable-first");
    const second = buildClosure(
      {},
      "portable-second-with-a-very-different-name",
    );

    assert.ok(first.root !== second.root);

    const a = await implementationDigest(first.packages);
    const b = await implementationDigest(second.packages);

    assert.match(a.digest, /^[0-9a-f]{64}$/);
    assert.equal(a.digest, b.digest);
    assert.equal(a.packages, b.packages);
    assert.equal(a.files, b.files);
    assert.equal(a.bytes, b.bytes);
  });

  it("does not carry an absolute installation path into the identity", async () => {
    const first = buildClosure({}, "nopath-one");
    const second = buildClosure({}, "nopath-two");
    const a = await implementationDigest(first.packages);

    // The identity is a digest and the inputs are relative: relocating the same
    // bytes cannot change it, so no absolute path participates.
    assert.doesNotMatch(
      a.digest,
      new RegExp(first.root.replaceAll("/", "\\/")),
    );
    assert.equal(
      a.digest,
      (await implementationDigest(second.packages)).digest,
    );
  });
});

describe("negative controls", () => {
  async function digestOf(options, label = "control") {
    const { packages } = buildClosure(options, label);
    return (await implementationDigest(packages)).digest;
  }

  const baseline = () => digestOf({}, "baseline");

  /** The invariant shared by every control: this change must move the digest. */
  async function differs(options, label = "control") {
    const before = await baseline();
    const after = await digestOf(options, label);
    assert.ok(
      before !== after,
      `the digest must change for ${JSON.stringify(options)}`,
    );
  }

  it("changes when a file byte changes", async () => {
    await differs({ alphaBody: "export const alpha = 9;\n" }, "byte");
  });

  it("changes when the executable bit changes", async () => {
    await differs({ executable: false }, "mode");
  });

  it("changes when a package version changes", async () => {
    await differs({ alphaVersion: "1.0.1" }, "version");
  });

  it("changes when the inventory changes", async () => {
    await differs({ extraPackage: true }, "inventory");
  });

  it("changes when an internal link is retargeted", async () => {
    await differs({ aliasTarget: "other.js" }, "internal-link");
  });

  it("changes when a package-to-package link is removed", async () => {
    await differs({ betaLinksAlpha: false }, "package-link");
  });

  it("refuses an external symlink instead of collapsing it", async () => {
    const { packages } = buildClosure({ externalLink: true }, "external");
    let error;
    try {
      await implementationDigest(packages);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof ToolchainViewError, String(error));
    assert.match(error.message, /outside the certified closure/);
  });

  it("refuses a broken symlink", async () => {
    const { packages } = buildClosure({ brokenLink: true }, "broken");
    let error;
    try {
      await implementationDigest(packages);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof ToolchainViewError, String(error));
    assert.match(error.message, /broken symlink/);
  });
});

describe("the certified closure", () => {
  it("contains no symlinks, so no link policy is in use", async () => {
    // The measured fact the policy is scoped by: if a link ever appears in the
    // closure, this test fails and the refusal/representation rules get exercised
    // by a real case instead of only by fixtures.
    const view = path.join(
      Deno.cwd(),
      "generator",
      "toolchain",
      "node_modules",
    );
    let exists = true;
    try {
      Deno.statSync(view);
    } catch {
      exists = false;
    }
    if (!exists) {
      // A machine without the installation proves nothing about the closure.
      return;
    }
    const { packagesFromView } = await import("./mise.mjs");
    const packages = packagesFromView(view);
    let links = 0;
    const walk = (directory) => {
      for (const entry of Deno.readDirSync(directory)) {
        if (entry.isSymlink) {
          links += 1;
          continue;
        }
        if (entry.isDirectory) walk(path.join(directory, entry.name));
      }
    };
    for (const entry of packages) walk(Deno.realPathSync(entry.directory));
    assert.equal(
      links,
      0,
      "the certified closure gained a symlink; re-examine the policy",
    );
  });
});
