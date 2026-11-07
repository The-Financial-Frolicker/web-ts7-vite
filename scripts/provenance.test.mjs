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
  rmSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";
import {
  GENERATOR_REPOSITORY,
  parseSource,
  renderSource,
  requireCleanTree,
  requireHeadIs,
  requireInstalledIdentity,
  resolveReleaseTag,
  validateSource,
} from "./lib/toolchain/provenance.mjs";
import { treeDigest } from "./lib/toolchain/tree-digest.mjs";
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
  const root = makeDir("s7-tc-");
  const nodeModules = path.join(root, "node_modules");
  mkdirSync(path.join(nodeModules, "vite"), { recursive: true });
  writeFileSync(
    path.join(nodeModules, "vite", "package.json"),
    '{"name":"vite"}\n',
  );
  const digest = (await treeDigest(nodeModules)).digest;
  writeFileSync(
    path.join(root, "toolchain.json"),
    JSON.stringify(
      {
        schema: 1,
        deno: "2.9.8",
        spec: "a".repeat(64),
        resolution: "b".repeat(64),
        materialisation: corrupt ? "c".repeat(64) : digest,
        packages: { vite: "8.3.5" },
      },
      null,
      2,
    ),
  );
  return { root, digest };
}

const VALID = {
  repository: GENERATOR_REPOSITORY,
  ref: "toolchain-2026.11.1",
  sha: "a".repeat(40),
  materialisation: "b".repeat(64),
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
      () => validateSource({ ...VALID, materialisation: "b".repeat(63) }),
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
  it("accepts a tree that matches its record", async () => {
    const { root, digest } = await makeToolchain();
    const { identity, observed } = await requireInstalledIdentity(
      root,
      treeDigest,
    );
    assert.equal(identity.materialisation, digest);
    assert.equal(observed.digest, digest);
  });

  it("refuses a missing installation", async () => {
    await rejects(
      () =>
        requireInstalledIdentity(
          path.join(makeDir("s7-empty-"), "tc"),
          treeDigest,
        ),
      /no valid toolchain identity/,
    );
  });

  it("refuses a record without a materialisation digest", async () => {
    const root = makeDir("s7-bad-");
    writeFileSync(path.join(root, "toolchain.json"), '{"schema":1}');
    await rejects(
      () => requireInstalledIdentity(root, treeDigest),
      /records no materialisation/,
    );
  });

  it("refuses a tree that no longer matches the recorded digest", async () => {
    const { root } = await makeToolchain({ corrupt: true });
    await rejects(
      () => requireInstalledIdentity(root, treeDigest),
      /does not match its own record/,
    );
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
    Deno.copyFileSync(
      path.join(Deno.cwd(), "scripts/lib/toolchain/tree-digest.mjs"),
      path.join(root, "scripts/lib/toolchain/tree-digest.mjs"),
    );
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

  const recordFor = (digest) => ({ ...VALID, materialisation: digest });

  it("reads a valid record as shell-evaluable assignments", async () => {
    const product = makeProduct(recordFor("b".repeat(64)));
    const { io, lines } = capture();
    assert.equal(await sourceMain(["read", "--root", product], io), 0);
    assert.ok(lines.includes(`TC_SHA=${VALID.sha}`), lines.join("\n"));
    assert.ok(
      lines.includes(`TC_MATERIALISATION=${"b".repeat(64)}`),
      lines.join("\n"),
    );
  });

  it("fails on missing, malformed or foreign metadata", async () => {
    for (
      const [label, value, pattern] of [
        ["missing", undefined, /no \.toolchain-source\.json/],
        ["malformed", "{ nope", /not valid JSON/],
        [
          "foreign",
          { ...recordFor("b".repeat(64)), repository: "evil/fork" },
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
    const { root: toolchain, digest } = await makeToolchain();

    const ok = capture();
    assert.equal(
      await sourceMain(
        [
          "verify",
          "--root",
          makeProduct(recordFor(digest)),
          "--generator",
          generator,
          "--toolchain-root",
          toolchain,
        ],
        ok.io,
      ),
      0,
      ok.lines.join("\n"),
    );
    assert.match(
      ok.lines.join("\n"),
      /provenance and materialisation verified/,
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
          "--toolchain-root",
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
          makeProduct(recordFor(digest)),
          "--generator",
          generator,
          "--toolchain-root",
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
        "the materialisation identity must move",
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
});
