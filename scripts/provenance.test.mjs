/**
 * Provenance contract tests (S7).
 *
 * Generation-side cases run against disposable git repositories and disposable
 * toolchain roots; the real history and the live installation are untouched.
 * Product-side cases exercise the shipped `toolchain-source.mjs` CLI as a
 * product workflow would.
 */

import assert from "./lib/assert.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "./lib/fs.mjs";
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
});
