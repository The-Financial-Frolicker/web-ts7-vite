/**
 * GitHub Actions output boundary (S7-H).
 *
 * These tests drive the *shipped* `toolchain-source.mjs` CLI and inspect what it
 * writes, rather than reasoning about the workflow's shell pipeline. Fixtures are
 * built by the Deno test runtime, so hostile payloads are never interpreted by a
 * shell on the way in.
 */

import assert from "./lib/assert.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";
import { GENERATOR_REPOSITORY } from "./lib/toolchain/provenance.mjs";
import { read as readInto } from "./toolchain-source.mjs";

const temporary = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

const VALID = Object.freeze({
  repository: GENERATOR_REPOSITORY,
  ref: "toolchain-2026.11.1",
  sha: "a".repeat(40),
  implementation: "c".repeat(64),
});

const EXPECTED = [
  `tc_repository=${VALID.repository}`,
  `tc_ref=${VALID.ref}`,
  `tc_sha=${VALID.sha}`,
];

/** Write a metadata fixture and run the real CLI against it. */
function emit(content, formatGitHub = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "s7h-"));
  temporary.push(dir);
  writeFileSync(
    path.join(dir, ".toolchain-source.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );

  const out = [];
  const err = [];
  let code = 0;
  try {
    readInto(dir, {
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    }, formatGitHub);
  } catch (error) {
    code = 1;
    err.push(error.message);
  }
  return { code, out, err };
}

const withField = (key, value) => ({ ...VALID, [key]: value });
const omit = (key) =>
  Object.fromEntries(Object.entries(VALID).filter(([name]) => name !== key));

describe("structured output (read --format=github)", () => {
  it("emits exactly the three records later steps consume", () => {
    const { code, out } = emit(VALID);
    assert.equal(code, 0);
    assert.deepEqual(out, EXPECTED);
  });

  it("keeps the human-readable interface unchanged", () => {
    const { code, out } = emit(VALID, false);
    assert.equal(code, 0);
    assert.deepEqual(out, [
      `TC_REPOSITORY=${VALID.repository}`,
      `TC_REF=${VALID.ref}`,
      `TC_SHA=${VALID.sha}`,
    ]);
  });
});

describe("hostile metadata cannot cross the output boundary", () => {
  const payloads = [
    "x; rm -rf /",
    "x$(id)",
    "x`id`",
    "x'y",
    'x"y',
    "x\ntc_sha=deadbeef",
    "x\r\ntc_sha=deadbeef",
    "x\nEOF\n",
    "x<<EOF",
    " ",
    "",
  ];

  it("rejects hostile values in every field with no output at all", () => {
    for (const key of ["repository", "ref", "sha"]) {
      for (const payload of payloads) {
        const { code, out, err } = emit(withField(key, payload));
        assert.equal(code, 1, `${key}=${JSON.stringify(payload)} was accepted`);
        assert.deepEqual(
          out,
          [],
          `${key}=${JSON.stringify(payload)} emitted output`,
        );
        assert.ok(err.length > 0, "a rejection must explain itself");
      }
    }
  });

  it("rejects structural defects with no output at all", () => {
    const cases = [
      ["missing sha", omit("sha")],
      ["missing repository", omit("repository")],
      ["unexpected field", { ...VALID, deno: "2.9.8" }],
      ["foreign repository", withField("repository", "evil/fork")],
      ["old tag format", withField("ref", "toolchain-2026.11")],
      ["zero sequence", withField("ref", "toolchain-2026.11.0")],
      ["short sha", withField("sha", "abc1234")],
      ["short digest", withField("implementation", "b".repeat(63))],
      ["non-string sha", withField("sha", 40)],
      ["null record", "null"],
      ["array record", "[]"],
      ["malformed JSON", "{ not json"],
      ["empty file", ""],
    ];

    for (const [label, content] of cases) {
      const { code, out, err } = emit(content);
      assert.equal(code, 1, `${label} was accepted`);
      assert.deepEqual(out, [], `${label} emitted output`);
      assert.ok(err.length > 0, `${label} produced no diagnostic`);
    }
  });

  it("never writes an error message to the log channel", () => {
    // The workflow appends stdout to $GITHUB_OUTPUT; diagnostics must not reach it.
    const { code, out } = emit(withField("ref", "main"));
    assert.equal(code, 1);
    assert.deepEqual(out, []);
  });
});
