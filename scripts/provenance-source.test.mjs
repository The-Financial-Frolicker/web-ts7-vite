/**
 * Product-side provenance tests (S9).
 *
 * These exercise the reader and verifier that ship with every generated
 * product (`scripts/toolchain-source.mjs`). They deliberately import nothing
 * from the generator's release machinery and nothing from its digest
 * implementation: the digest function is a stub written into a temporary
 * "generator checkout", which is exactly the interface `verify` consumes.
 *
 * Release construction — clean tree, annotated tag, tag/commit equality — is
 * generator-side behaviour and is tested in `provenance.test.mjs`, which never
 * travels to a product.
 */

import assert from "./lib/assert.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";
import { main } from "./toolchain-source.mjs";

const REPOSITORY = "The-Financial-Frolicker/web-ts7-vite";
const MATERIALISATION =
  "cfb528d9fd237b6684b36246e5dec663cc630eeab4b1d94fd3227620ba853be2";
const IMPLEMENTATION =
  "27548aeeb69555a1a35f9830e69758757bde914fe0efd22cbcd6883907ad0a7b";

const temporary = [];
function makeDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** Collector for what a workflow step would consume. */
function recorder() {
  const out = [];
  const err = [];
  return { out, err, log: (line) => out.push(line), error: (l) => err.push(l) };
}

function product(overrides = {}) {
  const dir = makeDir("s9-product-");
  const record = {
    repository: REPOSITORY,
    ref: "toolchain-2026.11.1",
    sha: "8836f76adf636e33af14bf5bd7b761afb53a30bd",
    implementation: IMPLEMENTATION,
    ...overrides,
  };
  writeFileSync(
    path.join(dir, ".toolchain-source.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return dir;
}

/**
 * A stand-in for the verified generator checkout: the only thing `verify`
 * imports from it is the digest implementation, so that is the only thing this
 * fixture provides.
 *
 * `verify` compares the cross-machine `implementationDigest` against the
 * product's recorded identity (C1 and C2). The whole-tree `digest` is only
 * of the view's structure: the runner-side self-check (R3) is deliberately
 * absent and deferred to the GitHub provenance workflow, so a differing
 * whole-tree value must not fail verification.
 */
function generatorCheckout(digest, entries = 3328, implementation = digest) {
  const dir = makeDir("s9-generator-");
  const module = path.join(dir, "scripts", "lib", "toolchain");
  mkdirSync(module, { recursive: true });
  // The verifier imports the generator's digest implementation; the fixture
  // supplies a stub with the same interface so the comparison logic is what is
  // under test, not this machine's installation.
  writeFileSync(
    path.join(module, "mise.mjs"),
    `export function packagesFromView() {
` +
      `  return [{ name: "stub", version: "0.0.0", directory: "/stub" }];
` +
      `}
` +
      `export async function implementationDigest() {
` +
      `  return { digest: ${JSON.stringify(implementation)}, packages: 1,
` +
      `    files: ${entries}, bytes: 0 };
` +
      `}
`,
  );
  return dir;
}

function installation(record) {
  const dir = makeDir("s9-toolchain-");
  mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  writeFileSync(
    path.join(dir, "toolchain.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return dir;
}

const IDENTITY = Object.freeze({
  schema: 1,
  deno: "2.9.8",
  platform: "linux-x86_64",
  spec: "2a2c3f273f6daab2dc28f729db9e76fc828ab1e61c7e9cc43038cb9760edc52e",
  resolution:
    "2acd5901681996673c660c44c51c0c5a148757b5f07b3113486d091b0e8b3068",
  implementation: IMPLEMENTATION,
});

describe("provenance reader (product)", () => {
  it("emits the shell assignments a workflow consumes", async () => {
    const io = recorder();
    const code = await main(["read", "--root", product()], io);
    assert.equal(code, 0);
    assert.deepEqual(io.out, [
      `TC_REPOSITORY=${REPOSITORY}`,
      "TC_REF=toolchain-2026.11.1",
      "TC_SHA=8836f76adf636e33af14bf5bd7b761afb53a30bd",
    ]);
  });

  it("emits exactly three structured records for GitHub Actions", async () => {
    const io = recorder();
    const code = await main(
      ["read", "--format=github", "--root", product()],
      io,
    );
    assert.equal(code, 0);
    assert.deepEqual(io.out, [
      `tc_repository=${REPOSITORY}`,
      "tc_ref=toolchain-2026.11.1",
      "tc_sha=8836f76adf636e33af14bf5bd7b761afb53a30bd",
    ]);
  });

  it("fails closed when the metadata is absent", async () => {
    const io = recorder();
    const dir = makeDir("s9-nometa-");
    const code = await main(["read", "--root", dir], io);
    assert.equal(code, 1);
    assert.deepEqual(io.out, []);
    assert.equal(io.err.length, 1);
  });

  it("fails closed when a field is hostile", async () => {
    const io = recorder();
    const code = await main(
      ["read", "--format=github", "--root", product({ ref: "a$(id)b" })],
      io,
    );
    assert.equal(code, 1);
    assert.deepEqual(io.out, []);
  });

  describe("provenance verifier (product)", () => {
    it("accepts a recorded, installed and observed digest that agree", async () => {
      const io = recorder();
      const code = await main([
        "verify",
        "--root",
        product(),
        "--generator",
        generatorCheckout(MATERIALISATION, 3328, IMPLEMENTATION),
        "--generator-root",
        installation(IDENTITY),
      ], io);
      assert.equal(code, 0, io.err.join("; "));
      assert.deepEqual(io.out.slice(-1), [
        "provenance and implementation verified",
      ]);
    });

    it("rejects a record that disagrees with the product", async () => {
      const io = recorder();
      const code = await main([
        "verify",
        "--root",
        product(),
        "--generator",
        generatorCheckout(MATERIALISATION, 3328, IMPLEMENTATION),
        "--generator-root",
        installation({ ...IDENTITY, implementation: "d".repeat(64) }),
      ], io);
      assert.equal(code, 1);
      assert.match(
        io.err.join(" "),
        /records implementation d{64}, the product expects/,
      );
    });

    it("rejects a tree that does not hash to the recorded digest", async () => {
      const io = recorder();
      const code = await main([
        "verify",
        "--root",
        product(),
        "--generator",
        generatorCheckout("e".repeat(64)),
        "--generator-root",
        installation(IDENTITY),
      ], io);
      assert.equal(code, 1);
      assert.match(io.err.join(" "), /implementation hashes to e{64}/);
    });

    it("reports the observed implementation and never the machine-specific view", async () => {
      const io = recorder();
      const code = await main([
        "verify",
        "--root",
        product(),
        "--generator",
        // Whole-tree digest differs from the installation record; the
        // implementation identity still agrees.
        generatorCheckout("f".repeat(64), 3328, IMPLEMENTATION),
        "--generator-root",
        installation(IDENTITY),
      ], io);
      assert.equal(code, 0, io.err.join("; "));
      // The comparison is on implementation content, and the observation is
      // reported. There is no whole-tree digest any more: the resolution view is
      // machine-specific and never enters the gate.
      assert.match(
        io.out.join("\n"),
        /observed implementation 27548ae[0-9a-f]*/,
      );
      assert.doesNotMatch(io.out.join("\n"), /observed materialisation/);
    });

    it("rejects an installation with no identity record", async () => {
      const io = recorder();
      const dir = makeDir("s9-empty-toolchain-");
      const code = await main([
        "verify",
        "--root",
        product(),
        "--generator",
        generatorCheckout(MATERIALISATION),
        "--generator-root",
        dir,
      ], io);
      assert.equal(code, 1);
      assert.match(io.err.join(" "), /no toolchain identity/);
    });

    it("rejects an identity record with no spec or resolution", async () => {
      const io = recorder();
      const code = await main([
        "verify",
        "--root",
        product(),
        "--generator",
        generatorCheckout(MATERIALISATION),
        "--generator-root",
        installation({ ...IDENTITY, spec: "", resolution: undefined }),
      ], io);
      assert.equal(code, 1);
      assert.match(io.err.join(" "), /no spec identity/);
      assert.match(io.err.join(" "), /no resolution identity/);
    });

    it("requires both location flags", async () => {
      const io = recorder();
      const code = await main([
        "verify",
        "--root",
        product(),
        "--generator",
        generatorCheckout(MATERIALISATION),
      ], io);
      assert.equal(code, 1);
      assert.match(
        io.err.join(" "),
        /requires --generator DIR and --generator-root/,
      );
    });

    it("reports usage for an unknown command", async () => {
      const io = recorder();
      const code = await main(["inspect"], io);
      assert.equal(code, 2);
      assert.match(io.err.join(" "), /usage: toolchain-source\.mjs/);
    });
  });
});
