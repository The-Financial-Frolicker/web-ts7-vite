/**
 * Scoped component identity, provenance and fingerprint regression tests.
 *
 * These use controlled fixtures rather than a second Emscripten installation.
 * That is deliberate: the test demonstrates fingerprint *semantics* (which
 * inputs are key for which scope), not the behaviour of any compiler.
 */
import assert from "./lib/assert.mjs";
import { readFileSync } from "./lib/fs.mjs";
import path from "./lib/path.mjs";
import { describe, it } from "./lib/test.mjs";

import { fingerprintOf } from "./contracts/canonical.mjs";
import {
  BUILD_PROVENANCE_FIELDS,
  buildProvenanceDigest,
  COMPONENTS,
  componentsForScope,
  fingerprintInputs,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_VITE_TARGET,
  SCOPE_WORKERD_RUNTIME,
  SCOPES,
} from "./contracts/scopes.mjs";
import { describeEmscripten } from "./contracts/toolchain.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

/** A synthetic identity carrying Emscripten provenance. */
function identity(emscriptenVersion = "4.0.0") {
  return {
    platform: "linux-x64-gnu",
    workerd: {
      version: "1.20261023.1",
      compatibilityDate: "2026-10-30",
      compatibilityFlags: [],
    },
    vite: { version: "8.3.5" },
    typescript: { version: "7.0.2" },
    emscripten: {
      sdkVersion: { value: "4.0.0", available: true },
      emscriptenVersion: { value: emscriptenVersion, available: true },
      clangVersion: { value: "21.0.0", available: true },
      llvmRevision: { value: "abc123", available: true },
      standardLibrary: { value: "sdk-provided", available: true },
      target: { value: "wasm32-unknown-emscripten", available: true },
    },
  };
}

describe("canonical component model", () => {
  it("declares Emscripten as non-key for every current scope", () => {
    assert.deepEqual([...COMPONENTS.emscripten.keyFor], []);

    for (const scope of SCOPES) {
      assert.equal(
        componentsForScope(scope).includes("emscripten"),
        false,
        `emscripten must not be key for ${scope}`,
      );
      assert.equal(
        "emscripten" in fingerprintInputs(scope, identity()),
        false,
        `fingerprint inputs for ${scope} must not mention emscripten`,
      );
    }
  });

  it("derives fingerprint inputs instead of declaring them twice", () => {
    assert.deepEqual(
      Object.keys(fingerprintInputs(SCOPE_WORKERD_RUNTIME, identity())).sort(),
      ["compatibilityDate", "compatibilityFlags", "platform", "workerd"],
    );
    assert.deepEqual(
      componentsForScope(SCOPE_WORKERD_RUNTIME).sort(),
      ["platform", "workerd"],
    );
    assert.deepEqual(
      componentsForScope(SCOPE_VITE_TARGET).sort(),
      ["platform", "vite"],
    );
    assert.deepEqual(
      componentsForScope(SCOPE_TYPESCRIPT_LIBRARIES).sort(),
      ["platform", "typescript"],
    );
  });

  it("preserves the fingerprints recorded in the committed artefact", async () => {
    const document = JSON.parse(
      readFileSync(path.join(projectRoot, "toolchain-contracts.json"), "utf8"),
    );
    const byScope = Object.fromEntries(
      Object.values(document.contracts).map((contract) => [
        contract.scope,
        contract,
      ]),
    );

    const runtime = byScope[SCOPE_WORKERD_RUNTIME].fingerprintInputs;
    const vite = byScope[SCOPE_VITE_TARGET].fingerprintInputs;
    const typescript = byScope[SCOPE_TYPESCRIPT_LIBRARIES].fingerprintInputs;
    const reconstructed = {
      platform: runtime.platform,
      workerd: {
        version: runtime.workerd,
        compatibilityDate: runtime.compatibilityDate,
        compatibilityFlags: runtime.compatibilityFlags,
      },
      vite: { version: vite.vite },
      typescript: { version: typescript.typescript },
    };

    for (const scope of SCOPES) {
      assert.equal(
        await fingerprintOf(fingerprintInputs(scope, reconstructed)),
        byScope[scope].fingerprint,
        `${scope} fingerprint changed meaning`,
      );
    }
  });
});

describe("Emscripten change without template regeneration", () => {
  it("leaves every runtime compatibility fingerprint unchanged", async () => {
    const before = identity("4.0.0");
    const after = identity("4.0.1");
    after.emscripten.clangVersion = { value: "22.0.0", available: true };
    after.emscripten.llvmRevision = { value: "def456", available: true };

    for (const scope of SCOPES) {
      assert.equal(
        await fingerprintOf(fingerprintInputs(scope, before)),
        await fingerprintOf(fingerprintInputs(scope, after)),
        `${scope} fingerprint must not depend on Emscripten`,
      );
    }
  });

  it("is still visible in build provenance", () => {
    assert.equal(
      buildProvenanceDigest(identity("4.0.0")) ===
        buildProvenanceDigest(identity("4.0.1")),
      false,
      "a compiler change must change the build provenance digest",
    );
    assert.equal(
      buildProvenanceDigest(identity("4.0.0")),
      buildProvenanceDigest(identity("4.0.0")),
    );
  });

  it("keeps probe evidence and installation markers out of the fingerprint", async () => {
    const withNoise = identity("4.0.0");
    withNoise.probeEvidence = { "es2025.set.union": "supported" };
    withNoise.emscripten.installation = { available: true, markers: {} };

    assert.equal(
      await fingerprintOf(fingerprintInputs(SCOPE_WORKERD_RUNTIME, withNoise)),
      await fingerprintOf(
        fingerprintInputs(SCOPE_WORKERD_RUNTIME, identity("4.0.0")),
      ),
    );
  });
});

describe("Emscripten provenance capture", () => {
  it("records the SDK pin and states why other fields are unavailable", () => {
    const provenance = describeEmscripten(projectRoot, new Map());

    assert.equal(provenance.sdkVersion.available, true);
    for (const field of ["clangVersion", "llvmRevision", "target"]) {
      assert.equal(provenance[field].available, false, field);
      assert.equal(typeof provenance[field].reason, "string");
    }
    assert.match(provenance.llvmRevision.reason, /never inferred/);
  });

  it("exposes every build-provenance field the digest consumes", () => {
    const provenance = describeEmscripten(projectRoot, new Map());

    for (const field of BUILD_PROVENANCE_FIELDS) {
      assert.equal(field in provenance, true, `missing ${field}`);
    }
  });

  it("records no machine-specific installation path", () => {
    const serialised = JSON.stringify(describeEmscripten(projectRoot));

    assert.equal(serialised.includes(projectRoot), false);
  });
});
