/**
 * Provenance contract tests (S7).
 *
 * Generation-side cases run against disposable git repositories and disposable
 * toolchain roots; the real history and the live installation are untouched.
 * Product-side cases exercise the shipped `toolchain-source.mjs` CLI as a
 * product workflow would.
 */

import assert from "./lib/assert.mjs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";
import {
  GENERATOR_REPOSITORY,
  parseSource,
  releaseProvenance,
  renderSource,
  requireCleanTree,
  requireHeadIs,
  requireInstalledIdentity,
  resolveReleaseTag,
  validateSource,
} from "./lib/toolchain/provenance.mjs";
import { metadataRule, treeDigest } from "./lib/toolchain/tree-digest.mjs";
import { main as sourceMain } from "./toolchain-source.mjs";

const temporary = [];
function makeDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = new Deno.Command("git", {
    args: [
      "--no-pager",
      "-c",
      "user.email=s7@example.invalid",
      "-c",
      "user.name=S7",
      ...args,
    ],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout).trim(),
  };
}
const runner = () => (args, cwd) => git(cwd, ...args);

/** assert.throws is synchronous in this suite; await rejecting helpers explicitly. */
async function rejects(fn, pattern) {
  try {
    await fn();
  } catch (error) {
    assert.match(String(error.message), pattern);
    return;
  }
  throw new Error(`expected rejection matching ${pattern}`);
}

function makeRepo(
  { tag = "toolchain-2026.11.1", annotated = true, extraCommit = false } = {},
) {
  const root = makeDir("s7-repo-");
  git(root, "init", "--initial-branch=main");
  writeFileSync(path.join(root, "file.txt"), "one\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-m", "first");
  if (tag !== null) {
    if (annotated) git(root, "tag", "-a", tag, "-m", `release ${tag}`);
    else git(root, "tag", tag);
  }
  if (extraCommit) {
    writeFileSync(path.join(root, "file.txt"), "two\n");
    git(root, "add", "file.txt");
    git(root, "commit", "-m", "second");
  }
  return root;
}

async function makeToolchain({ corrupt = false } = {}) {
  // A view over a package store: schema 2 observes the packages the view
  // resolves, so the fixture is a symlink into a real package directory.
  const root = makeDir("s7-tc-");
  const store = makeDir("s7-store-");
  const pkg = path.join(store, "vite");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    path.join(pkg, "package.json"),
    '{"name":"vite","version":"8.3.5"}\n',
  );
  writeFileSync(path.join(pkg, "index.js"), "export default 1;\n");

  const nodeModules = path.join(root, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  Deno.symlinkSync(pkg, path.join(nodeModules, "vite"));

  const { implementationDigest, packagesFromView } = await import(
    new URL("./lib/toolchain/mise.mjs", import.meta.url).href
  );
  const observed = await implementationDigest(packagesFromView(nodeModules));
  const implementation = corrupt ? "d".repeat(64) : observed.digest;

  writeFileSync(
    path.join(root, "toolchain.json"),
    JSON.stringify(
      {
        schema: 2,
        role: "toolchain",
        owner: "mise",
        deno: "2.9.8",
        spec: "a".repeat(64),
        resolution: "b".repeat(64),
        implementation,
        resolved: [{ name: "vite", version: "8.3.5" }],
      },
      null,
      2,
    ),
  );

  return {
    root,
    digest: observed.digest,
    implementation,
    resolution: "b".repeat(64),
  };
}

const VALID = {
  repository: GENERATOR_REPOSITORY,
  ref: "toolchain-2026.11.1",
  sha: "a".repeat(40),
  implementation: "c".repeat(64),
};

describe("provenance metadata schema", () => {
  it("accepts the record and round-trips canonically", () => {
    assert.deepEqual(validateSource({ ...VALID }), VALID);
    assert.equal(parseSource(renderSource(VALID)).sha, VALID.sha);
  });

  it("rejects a foreign repository, a mutable ref, a short SHA and a bad digest", () => {
    assert.throws(
      () => validateSource({ ...VALID, repository: "x/y" }),
      /approved generator/,
    );
    assert.throws(
      () => validateSource({ ...VALID, ref: "main" }),
      /release tag of the form toolchain-YYYY.MM.N/,
    );
    assert.throws(
      () => validateSource({ ...VALID, sha: "abc1234" }),
      /40-character/,
    );
    assert.throws(
      () => validateSource({ ...VALID, implementation: "b".repeat(63) }),
      /64-character/,
    );
  });

  it("rejects unknown fields rather than ignoring them", () => {
    assert.throws(
      () => validateSource({ ...VALID, deno: "2.9.8" }),
      /unknown field/,
    );
  });
});

describe("release prerequisites", () => {
  it("accepts a clean tree with an annotated tag on HEAD", () => {
    const root = makeRepo();
    requireCleanTree(root, runner());
    const sha = resolveReleaseTag(root, "toolchain-2026.11.1", runner());
    assert.match(sha, /^[0-9a-f]{40}$/);
    requireHeadIs(root, sha, runner());
  });

  it("refuses a dirty tracked file and an untracked file", () => {
    const dirty = makeRepo();
    writeFileSync(path.join(dirty, "file.txt"), "changed\n");
    assert.throws(
      () => requireCleanTree(dirty, runner()),
      /working tree is dirty/,
    );

    const untracked = makeRepo();
    writeFileSync(path.join(untracked, "scratch.txt"), "x\n");
    assert.throws(
      () => requireCleanTree(untracked, runner()),
      /working tree is dirty/,
    );
  });

  it("refuses a lightweight tag", () => {
    const root = makeRepo({ annotated: false });
    assert.throws(
      () => resolveReleaseTag(root, "toolchain-2026.11.1", runner()),
      /not an annotated tag/,
    );
  });

  it("refuses a missing tag", () => {
    const root = makeRepo({ tag: null });
    assert.throws(
      () => resolveReleaseTag(root, "toolchain-2026.11.1", runner()),
      /does not exist/,
    );
  });

  it("refuses when the tag resolves to a different commit than HEAD", () => {
    const root = makeRepo({ extraCommit: true });
    const sha = resolveReleaseTag(root, "toolchain-2026.11.1", runner());
    assert.throws(
      () => requireHeadIs(root, sha, runner()),
      /HEAD is .* but release/,
    );
  });
});

describe("installed toolchain identity", () => {
  it("reads a record and takes no tree digest", async () => {
    const { root, implementation, resolution } = await makeToolchain();
    const identity = requireInstalledIdentity(root);
    assert.equal(identity.implementation, implementation);
    assert.equal(identity.resolution, resolution);
    // Schema 2 records the implementation content and the view structure; there
    // is no copied tree, so there is no materialisation digest to read.
    // No copied tree exists, so the record has no materialisation field.
    assert.equal(identity.materialisation, undefined);
    // The identity is read, never re-observed: the release path injects no
    // digest function at all (R1 and R2 removed).
    assert.equal(requireInstalledIdentity.length, 1);
  });

  it("refuses a missing installation", async () => {
    await rejects(
      () => requireInstalledIdentity(path.join(makeDir("s7-empty-"), "tc")),
      /no valid toolchain identity/,
    );
  });

  it("refuses a record without a resolution identity", async () => {
    const root = makeDir("s7-bad-");
    writeFileSync(path.join(root, "toolchain.json"), '{"schema":2}');
    await rejects(
      () => requireInstalledIdentity(root),
      /records no resolution identity/,
    );
  });

  it("refuses a record whose implementation identity is malformed", async () => {
    const root = makeDir("s7-bad-impl-");
    writeFileSync(
      path.join(root, "toolchain.json"),
      JSON.stringify({
        schema: 2,
        spec: "c".repeat(64),
        resolution: "c".repeat(64),
        implementation: "short",
      }),
    );
    await rejects(
      () => requireInstalledIdentity(root),
      /records no implementation identity/,
    );
  });

  it("accepts a record that disagrees with the tree, because the tree is not audited", async () => {
    // The fixture record deliberately disagrees with the tree on disk. The
    // release path must still accept it: materialisation correctness belongs to
    // the installer, and re-hashing an immutable installation on the reference
    // workstation restated a fact the installation had already established. The
    // runner-side equivalent is deferred to the provenance workflow (README,
    // "Digest comparison responsibilities").
    const { root } = await makeToolchain({ corrupt: true });
    const identity = requireInstalledIdentity(root);
    assert.match(identity.resolution, /^[0-9a-f]{64}$/);
    assert.match(identity.implementation, /^[0-9a-f]{64}$/);
    // No copied tree exists, so the record has no materialisation field.
    assert.equal(identity.materialisation, undefined);
  });
});

describe("product CI gate", () => {
  function makeProduct(record) {
    const root = makeDir("s7-product-");
    if (record !== undefined) {
      writeFileSync(
        path.join(root, ".toolchain-source.json"),
        typeof record === "string" ? record : renderSource(record),
      );
    }
    return root;
  }

  function generatorCheckout() {
    const root = makeDir("s7-gen-");
    mkdirSync(path.join(root, "scripts", "lib", "toolchain"), {
      recursive: true,
    });
    // The verifier imports the generator's own digest implementation. It lives
    // in `mise.mjs` (implementation identity is a digest of the resolved
    // packages), with the filesystem and path helpers it imports beside it.
    for (const relative of ["mise.mjs", "../fs.mjs", "../path.mjs"]) {
      const source = path.join(Deno.cwd(), "scripts/lib/toolchain", relative);
      const target = path.join(root, "scripts/lib/toolchain", relative);
      Deno.copyFileSync(
        source,
        Deno.realPathSync(path.dirname(target)) + "/" +
          path.basename(target),
      );
    }
    return root;
  }

  function capture() {
    const lines = [];
    return {
      io: {
        log: (m) => lines.push(m),
        error: (m) => lines.push(`error: ${m}`),
      },
      lines,
    };
  }

  const recordFor = (implementation) => ({
    ...VALID,
    implementation,
  });

  it("reads a valid record as shell-evaluable assignments", async () => {
    const product = makeProduct(recordFor("c".repeat(64)));
    const { io, lines } = capture();
    assert.equal(await sourceMain(["read", "--root", product], io), 0);
    // The consumer interface is the generator identity triad. The published
    // implementation is verified against the installed toolchain by `verify`,
    // and the machine-specific resolution view is never published, so no
    // materialisation assignment exists.
    assert.deepEqual(lines, [
      `TC_REPOSITORY=${VALID.repository}`,
      `TC_REF=${VALID.ref}`,
      `TC_SHA=${VALID.sha}`,
    ]);
  });

  it("fails on missing, malformed or foreign metadata", async () => {
    for (
      const [label, value, pattern] of [
        ["missing", undefined, /no \.toolchain-source\.json/],
        ["malformed", "{ nope", /not valid JSON/],
        [
          "foreign",
          {
            ...recordFor("c".repeat(64)),
            repository: "evil/fork",
          },
          /approved generator/,
        ],
      ]
    ) {
      const product = makeProduct(value);
      const { io, lines } = capture();
      assert.equal(await sourceMain(["read", "--root", product], io), 1, label);
      assert.match(lines.join("\n"), pattern, label);
    }
  });

  it("verifies an installation that matches the record, and fails otherwise", async () => {
    const generator = generatorCheckout();
    const { root: toolchain, implementation } = await makeToolchain();

    const ok = capture();
    assert.equal(
      await sourceMain(
        [
          "verify",
          "--root",
          makeProduct(recordFor(implementation)),
          "--generator",
          generator,
          "--generator-root",
          toolchain,
        ],
        ok.io,
      ),
      0,
      ok.lines.join("\n"),
    );
    assert.match(
      ok.lines.join("\n"),
      /provenance and implementation verified/,
    );

    const mismatched = capture();
    assert.equal(
      await sourceMain(
        [
          "verify",
          "--root",
          makeProduct(recordFor("d".repeat(64))),
          "--generator",
          generator,
          "--generator-root",
          toolchain,
        ],
        mismatched.io,
      ),
      1,
    );
    assert.match(mismatched.lines.join("\n"), /the product expects/);

    const empty = capture();
    assert.equal(
      await sourceMain(
        [
          "verify",
          "--root",
          makeProduct(recordFor(implementation)),
          "--generator",
          generator,
          "--generator-root",
          makeDir("s7-none-"),
        ],
        empty.io,
      ),
      1,
    );
    assert.match(empty.lines.join("\n"), /no toolchain identity/);
  });

  describe("tree digest diagnostics", () => {
    // A tree with one plain file and one executable, so a mode change and a name
    // change can each be made without disturbing the other column.
    function fixture() {
      const root = makeDir("digest-");
      mkdirSync(path.join(root, "bin"), { recursive: true });
      writeFileSync(path.join(root, "a.txt"), "alpha");
      writeFileSync(path.join(root, "bin", "tool"), "beta");
      chmodSync(path.join(root, "bin", "tool"), 0o755);
      return root;
    }

    it("is deterministic for identical trees", async () => {
      const first = await treeDigest(fixture());
      const second = await treeDigest(fixture());

      assert.equal(first.digest, second.digest);
      assert.equal(first.modeDigest, second.modeDigest);
      assert.equal(first.pathDigest, second.pathDigest);
      assert.equal(first.files, second.files);
      assert.equal(first.dirs, second.dirs);
    });

    it("changes the mode column when only a mode changes", async () => {
      const root = fixture();
      const before = await treeDigest(root);

      chmodSync(path.join(root, "bin", "tool"), 0o644);
      const after = await treeDigest(root);

      assert.ok(
        before.modeDigest !== after.modeDigest,
        "mode column must move",
      );
      assert.equal(before.pathDigest, after.pathDigest, "paths are unchanged");
      assert.ok(before.digest !== after.digest, "the identity must move");
    });

    it("changes the path column when only a name changes", async () => {
      const root = fixture();
      const before = await treeDigest(root);

      writeFileSync(path.join(root, "renamed.txt"), "alpha");
      rmSync(path.join(root, "a.txt"));
      const after = await treeDigest(root);

      assert.ok(
        before.pathDigest !== after.pathDigest,
        "path column must move",
      );
      assert.equal(before.modeDigest, after.modeDigest, "modes are unchanged");
      assert.ok(before.digest !== after.digest, "the identity must move");
    });

    it("leaves both diagnostic columns alone when only content changes", async () => {
      const root = fixture();
      const before = await treeDigest(root);

      writeFileSync(path.join(root, "a.txt"), "epsilon");
      const after = await treeDigest(root);

      assert.equal(before.modeDigest, after.modeDigest);
      assert.equal(before.pathDigest, after.pathDigest);
      assert.ok(
        before.digest !== after.digest,
        "content must still change the identity",
      );
    });

    it("does not disturb repeated measurement", async () => {
      const root = fixture();
      const first = await treeDigest(root);
      const second = await treeDigest(root);

      assert.deepEqual(first, second);
      assert.equal(first.pathModeDigest, second.pathModeDigest);
    });

    it("sees a mode swap that leaves both other diagnostic columns identical", async () => {
      // The case the first two diagnostics cannot resolve: the *distribution* of
      // modes is untouched, so only the path-to-mode binding (and the identity)
      // can tell that the tree changed. Both files are the same size, so the
      // byte counter is unaffected too.
      const root = makeDir("swap-");
      writeFileSync(path.join(root, "a.mjs"), "alpha");
      writeFileSync(path.join(root, "b.mjs"), "bravo");
      chmodSync(path.join(root, "a.mjs"), 0o644);
      chmodSync(path.join(root, "b.mjs"), 0o755);

      const before = await treeDigest(root);

      chmodSync(path.join(root, "a.mjs"), 0o755);
      chmodSync(path.join(root, "b.mjs"), 0o644);
      const after = await treeDigest(root);

      assert.equal(before.files, after.files, "file count is unchanged");
      assert.equal(before.dirs, after.dirs, "directory count is unchanged");
      assert.equal(before.symlinks, after.symlinks, "no symlinks change");
      assert.equal(before.bytes, after.bytes, "sizes are unchanged");
      assert.equal(
        before.modeDigest,
        after.modeDigest,
        "the mode distribution is identical",
      );
      assert.equal(
        before.pathDigest,
        after.pathDigest,
        "the path set is identical",
      );
      assert.ok(
        before.pathModeDigest !== after.pathModeDigest,
        "the path-to-mode binding must move",
      );
      assert.ok(
        before.digest !== after.digest,
        "the published identity must move",
      );
    });

    it("is stable across identical trees", async () => {
      const first = await treeDigest(fixture());
      const second = await treeDigest(fixture());

      assert.equal(first.pathModeDigest, second.pathModeDigest);
    });

    it("moves when a single file's mode changes", async () => {
      const root = fixture();
      const before = await treeDigest(root);

      chmodSync(path.join(root, "a.txt"), 0o755);
      const after = await treeDigest(root);

      assert.ok(before.pathModeDigest !== after.pathModeDigest);
    });

    it("moves when a file is renamed", async () => {
      const root = fixture();
      const before = await treeDigest(root);

      writeFileSync(path.join(root, "renamed.txt"), "alpha");
      rmSync(path.join(root, "a.txt"));
      const after = await treeDigest(root);

      assert.ok(before.pathModeDigest !== after.pathModeDigest);
    });

    it("stays put when only file contents change", async () => {
      const root = fixture();
      const before = await treeDigest(root);

      writeFileSync(path.join(root, "a.txt"), "epsilon");
      const after = await treeDigest(root);

      assert.equal(before.pathModeDigest, after.pathModeDigest);
      assert.ok(
        before.digest !== after.digest,
        "the identity must still notice the content",
      );
    });
  });

  describe("dependency implementation identity", () => {
    // A miniature Deno store, so every rule is exercised at its real anchor:
    //   .deno/<pkg>@<ver>/node_modules/<pkg>/…
    function store() {
      const root = makeDir("impl-");
      const entry = path.join(root, ".deno", "vite@8.3.5");
      const pkg = path.join(entry, "node_modules", "vite");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(path.join(pkg, "package.json"), '{"name":"vite"}\n');
      writeFileSync(path.join(pkg, "index.js"), "export default 1;\n");
      writeFileSync(path.join(entry, ".initialized"), "");
      return { root, entry, pkg };
    }

    const identity = async (root) =>
      (await treeDigest(root)).implementationDigest;

    it("is identical for the same content under different roots", async () => {
      const first = await treeDigest(store().root);
      const second = await treeDigest(store().root);

      assert.equal(first.implementationDigest, second.implementationDigest);
      assert.equal(first.metadataDigest, second.metadataDigest);
      assert.equal(first.digest, second.digest);
    });

    it("moves for content, addition, removal and rename", async () => {
      const { root, pkg } = store();
      const base = await identity(root);

      writeFileSync(path.join(pkg, "index.js"), "export default 2;\n");
      const content = await identity(root);
      assert.ok(content !== base, "content");

      writeFileSync(path.join(pkg, "extra.js"), "x\n");
      const added = await identity(root);
      assert.ok(added !== content, "addition");

      rmSync(path.join(pkg, "extra.js"));
      writeFileSync(path.join(pkg, "renamed.js"), "export default 1;\n");
      const renamed = await identity(root);
      assert.ok(renamed !== added, "rename");

      rmSync(path.join(pkg, "renamed.js"));
      writeFileSync(path.join(pkg, "index.js"), "export default 1;\n");
      assert.ok((await identity(root)) !== renamed, "removal");
    });

    it("uses the owner triad, and only the owner triad", async () => {
      const { root, pkg } = store();
      const file = path.join(pkg, "index.js");
      const base = await treeDigest(root);

      for (const mode of [0o400, 0o700, 0o500]) {
        chmodSync(file, mode);
        assert.ok(
          (await identity(root)) !== base.implementationDigest,
          `owner mode ${mode.toString(8)} must move the identity`,
        );
      }

      chmodSync(file, 0o644);
      const owner = (await treeDigest(root)).implementationDigest;
      for (const mode of [0o664, 0o604, 0o666, 0o4644, 0o2644]) {
        chmodSync(file, mode);
        assert.equal(
          (await treeDigest(root)).implementationDigest,
          owner,
          `non-owner bits in ${mode.toString(8)} must not move the identity`,
        );
      }
    });

    it("covers directories by path and owner mode", async () => {
      const { root, pkg } = store();
      const base = await identity(root);

      // Create the full subtree first: a directory without the owner write bit
      // cannot later gain a child, so ordering is part of the fixture.
      mkdirSync(path.join(pkg, "sub", "deeper"), { recursive: true });
      const withDir = await identity(root);
      assert.ok(withDir !== base, "directory addition");

      chmodSync(path.join(pkg, "sub"), 0o500);
      const tightened = await identity(root);
      assert.ok(tightened !== withDir, "directory owner mode");

      chmodSync(path.join(pkg, "sub"), 0o755);
      assert.equal(
        await identity(root),
        withDir,
        "restoring the owner triad must restore the identity",
      );

      rmSync(path.join(pkg, "sub"), { recursive: true });
      assert.ok((await identity(root)) !== withDir, "directory removal");
    });

    it("records symlinks literally and never follows them", async () => {
      const { root, pkg } = store();
      const outside = makeDir("impl-outside-");
      writeFileSync(path.join(outside, "data.txt"), "one\n");

      Deno.symlinkSync(path.join(outside, "data.txt"), path.join(pkg, "link"));
      const linked = await identity(root);

      writeFileSync(path.join(outside, "data.txt"), "two\n");
      assert.equal(await identity(root), linked, "must not follow the symlink");

      Deno.removeSync(path.join(pkg, "link"));
      Deno.symlinkSync(path.join(outside, "other.txt"), path.join(pkg, "link"));
      assert.ok((await identity(root)) !== linked, "literal target change");
    });

    it("includes unknown files and keeps executable changes detectable", async () => {
      const { root, pkg } = store();
      const base = await identity(root);

      writeFileSync(path.join(pkg, ".mystery"), "");
      assert.ok((await identity(root)) !== base, "unknown zero-byte file");

      writeFileSync(path.join(pkg, "binding.node"), "binary\n");
      const plain = await identity(root);
      chmodSync(path.join(pkg, "binding.node"), 0o755);
      assert.ok((await identity(root)) !== plain, "native binding exec bit");
    });
  });
});

describe("installer metadata recognition", () => {
  function store() {
    const root = makeDir("meta-");
    const entry = path.join(root, ".deno", "vite@8.3.5");
    const pkg = path.join(entry, "node_modules", "vite");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "index.js"), "export default 1;\n");
    return { root, entry, pkg };
  }

  const snapshot = async (root) => await treeDigest(root);

  it("excludes each rule at its approved anchor", async () => {
    for (
      const [rule, target] of [
        ["M1", (s) => path.join(s.root, ".deno", ".deno.lock")],
        ["M2", (s) => path.join(s.root, ".deno", ".setup-cache.bin")],
        ["M3", (s) => path.join(s.entry, ".initialized")],
        ["M4", (s) => path.join(s.entry, ".scripts-warned")],
        ["M5", (s) => path.join(s.pkg, ".scripts-warned-123")],
      ]
    ) {
      const fixture = store();
      const before = await snapshot(fixture.root);
      writeFileSync(target(fixture), "");
      const after = await snapshot(fixture.root);

      assert.equal(
        after.implementationDigest,
        before.implementationDigest,
        `${rule} must not enter the implementation identity`,
      );
      assert.equal(after.metadataFiles, before.metadataFiles + 1, rule);
      assert.ok(after.metadataDigest !== before.metadataDigest, rule);
    }
  });

  it("rejects M3/M4 names outside a store entry", async () => {
    const { root, pkg } = store();
    const base = (await snapshot(root)).implementationDigest;
    writeFileSync(path.join(pkg, ".initialized"), "");
    writeFileSync(path.join(pkg, ".scripts-warned"), "");
    assert.ok(
      (await snapshot(root)).implementationDigest !== base,
      "same names inside a package payload stay in the implementation",
    );
  });

  it("requires M5's numeric suffix, zero length, file type and payload", async () => {
    const { root, entry, pkg } = store();

    writeFileSync(path.join(pkg, ".scripts-warned"), "");
    assert.equal(
      metadataRule(
        "node_modules/.deno/x@1/node_modules/p/.scripts-warned",
        "file",
        0,
      ),
      null,
      "no numeric suffix is not M5",
    );

    writeFileSync(path.join(pkg, ".scripts-warned-1"), "not empty\n");
    assert.equal(
      metadataRule(
        "node_modules/.deno/x@1/node_modules/p/.scripts-warned-1",
        "file",
        9,
      ),
      null,
      "a non-empty file is not M5",
    );

    // A directory and a symlink of the same name are not M5.
    mkdirSync(path.join(pkg, ".scripts-warned-2"));
    Deno.symlinkSync("index.js", path.join(pkg, ".scripts-warned-3"));
    assert.equal(
      metadataRule(
        "node_modules/.deno/x@1/node_modules/p/.scripts-warned-2",
        "directory",
        0,
      ),
      null,
      "a directory is not M5",
    );

    // Outside the package payload, and outside the store entirely.
    assert.equal(
      metadataRule("node_modules/.deno/x@1/.scripts-warned-4", "file", 0),
      null,
      "outside the payload is not M5",
    );
    assert.equal(
      metadataRule("node_modules/vite/.scripts-warned-5", "file", 0),
      null,
      "an application package is not a Deno store",
    );
    // Zero-byte and correctly named, but outside the payload in both cases:
    // directly in the store entry, and in an application directory.
    const nearMiss = (await snapshot(root)).implementationDigest;
    writeFileSync(path.join(entry, ".scripts-warned-6"), "");
    mkdirSync(path.join(root, "app"), { recursive: true });
    writeFileSync(path.join(root, "app", ".scripts-warned-7"), "");
    assert.ok(
      (await snapshot(root)).implementationDigest !== nearMiss,
      "near-miss placements must remain part of the implementation",
    );
  });

  it("does not require any particular mode for M5", async () => {
    for (const mode of [0o644, 0o600, 0o755]) {
      const { root, pkg } = store();
      const before = await snapshot(root);
      const marker = path.join(pkg, ".scripts-warned-42");
      writeFileSync(marker, "");
      chmodSync(marker, mode);
      const after = await snapshot(root);

      assert.equal(
        after.implementationDigest,
        before.implementationDigest,
        `mode ${mode.toString(8)} must not change the classification`,
      );
      assert.equal(after.metadataFiles, before.metadataFiles + 1);
    }
  });
});

describe("metadata diagnostic sensitivity and fail-closed traversal", () => {
  function store() {
    const root = makeDir("diag-");
    const entry = path.join(root, ".deno", "vite@8.3.5");
    const pkg = path.join(entry, "node_modules", "vite");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "index.js"), "export default 1;\n");
    return { root, entry, pkg };
  }

  it("tracks addition, removal, path, content and mode without touching identity", async () => {
    const { root, entry } = store();
    const base = await treeDigest(root);

    writeFileSync(path.join(root, ".deno", ".setup-cache.bin"), "one\n");
    const added = await treeDigest(root);
    assert.equal(added.implementationDigest, base.implementationDigest);
    assert.ok(added.metadataDigest !== base.metadataDigest, "addition");
    assert.equal(added.metadataFiles, base.metadataFiles + 1);

    writeFileSync(path.join(root, ".deno", ".setup-cache.bin"), "two\n");
    const content = await treeDigest(root);
    assert.equal(content.implementationDigest, base.implementationDigest);
    assert.ok(content.metadataDigest !== added.metadataDigest, "content");

    chmodSync(
      path.join(root, ".deno", ".setup-cache.bin"),
      0o600,
    );
    const mode = await treeDigest(root);
    assert.ok(mode.metadataDigest !== content.metadataDigest, "mode");

    // Path change: the same content at a different anchored location.
    rmSync(path.join(root, ".deno", ".setup-cache.bin"));
    writeFileSync(path.join(entry, ".initialized"), "");
    const moved = await treeDigest(root);
    assert.equal(moved.implementationDigest, base.implementationDigest);
    assert.ok(moved.metadataDigest !== mode.metadataDigest, "path");

    rmSync(path.join(entry, ".initialized"));
    const removed = await treeDigest(root);
    assert.equal(removed.metadataDigest, base.metadataDigest, "removal");
    assert.equal(removed.metadataFiles, base.metadataFiles);
  });

  it("classifies deterministically across different roots", async () => {
    const first = store();
    const second = store();
    for (const fixture of [first, second]) {
      writeFileSync(path.join(fixture.root, ".deno", ".deno.lock"), "");
      writeFileSync(path.join(fixture.pkg, ".scripts-warned-9"), "");
    }
    const a = await treeDigest(first.root);
    const b = await treeDigest(second.root);

    assert.equal(a.implementationDigest, b.implementationDigest);
    assert.equal(a.metadataDigest, b.metadataDigest);
    assert.equal(a.metadataFiles, b.metadataFiles);
  });

  it("fails closed on an unsupported filesystem entry", async () => {
    const { root } = store();
    const fifo = path.join(root, "pipe");
    let created = false;
    try {
      new Deno.Command("mkfifo", { args: [fifo] }).outputSync();
      created = Deno.lstatSync(fifo).isFifo;
    } catch {
      created = false;
    }

    if (!created) {
      // Environmental limitation, reported rather than silently skipped.
      console.warn("mkfifo unavailable; fail-closed path not exercised");
      return;
    }

    let message = "";
    try {
      await treeDigest(root);
      assert.ok(false, "a FIFO must not be silently encoded");
    } catch (error) {
      message = error.message;
    }
    assert.match(message, /unsupported filesystem entry fifo/);
    assert.match(message, /"pipe"/);
  });
});

describe("release provenance on the reference workstation", () => {
  it("publishes the recorded identity without digesting the tree", async () => {
    const repo = makeRepo();
    const { root: toolchain } = await makeToolchain();
    let digestCalls = 0;
    const digest = () => {
      digestCalls += 1;
      throw new Error("the release path must not digest the dependency tree");
    };

    const record = await releaseProvenance({
      root: repo,
      ref: "toolchain-2026.11.1",
      generatorInstallationRoot: toolchain,
      run: runner(),
      // An injected digest the release path must never reach.
      digest,
    });

    assert.equal(digestCalls, 0, "the local release path took no tree digest");

    const identity = JSON.parse(
      readFileSync(path.join(toolchain, "toolchain.json"), "utf8"),
    );
    const sha = git(repo, "rev-parse", "HEAD").stdout;
    assert.equal(record.sha, sha);
    // Both product fields carry the portable implementation identity; the
    // machine-specific view digest is never published.
    assert.equal(record.implementation, identity.implementation);
    assert.equal(record.materialisation, undefined);
    assert.ok(
      identity.resolution !== identity.implementation,
      "the machine-specific view digest is separate from the content identity",
    );
    assert.equal(record.implementation, identity.implementation);

    // Byte-identical to the metadata published before R1/R2 were removed: the
    // values come from the installer's record, never from a fresh observation.
    assert.equal(
      renderSource(record),
      `${
        JSON.stringify(
          {
            repository: GENERATOR_REPOSITORY,
            ref: "toolchain-2026.11.1",
            sha,
            implementation: identity.implementation,
          },
          null,
          2,
        )
      }
`,
    );
  });
});
