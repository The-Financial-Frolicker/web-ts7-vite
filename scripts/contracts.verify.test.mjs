/**
 * Product-side contract tests.
 *
 * This suite ships in the generated product. It covers what a product can do:
 * validate a v2 lock, recompute conformance, report a missing scope differently
 * from a changed one, and refuse to acquire any authoring capability.
 */
import assert from "./lib/assert.mjs";
import {
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
  canonicalJson,
  contractKey,
  fingerprintOf,
} from "./contracts/canonical.mjs";
import { contractInputs } from "./contracts/identity.mjs";
import {
  CONTRACT_STATUSES,
  SCHEMA_VERSION,
  validateDocument,
} from "./contracts/schema.mjs";
import {
  fingerprintInputs,
  SCOPE_LAUNCHER_PERMISSIONS,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_VITE_TARGET,
  SCOPE_WORKERD_RUNTIME,
  SCOPES,
} from "./contracts/scopes.mjs";
import {
  buildConformanceReport,
  denoProblems,
  generatedConfigProblems,
  summariseScope,
} from "./contracts/verify.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "product-contracts-"));
  temporaryRoots.push(root);
  return root;
}

function write(root, file, contents) {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
  );
}

/**
 * A fixture digest for the declared probe catalogue.
 *
 * Deliberately not the catalogue-derived value: these tests assert the shape of
 * the fingerprint, not which probes the project happens to declare.
 */
const FIXTURE_CAPABILITIES = `sha256:${"f".repeat(64)}`;

/** A synthetic identity in the shape derivation and reporting consume. */
function identity(overrides = {}) {
  return {
    platform: { key: "linux-x64-gnu" },
    wrangler: {
      compatibilityDate: "2026-10-30",
      compatibilityFlags: [],
      file: "wrangler.jsonc",
    },
    graph: { workerdVersion: "1.20261023.1" },
    vite: {
      manifest: { version: "8.3.5" },
      buildTarget: "baseline-widely-available",
    },
    typescript: {
      manifest: { version: "7.0.2" },
      clientLib: ["ES2023", "DOM"],
      workerLib: ["ES2025"],
    },
    launchers: {
      "vite-build": ["--allow-read", "--allow-write"],
      "edge-verify": ["--allow-read", "--allow-net=127.0.0.1"],
    },
    capabilities: FIXTURE_CAPABILITIES,
    ...overrides,
  };
}

function value(provenance, entry = true) {
  return { kind: "test", value: entry, provenance, evidence: "fixture" };
}

/** Minimal valid values per scope; the report tests do not inspect them. */
function scopeValues(scope) {
  switch (scope) {
    case SCOPE_WORKERD_RUNTIME:
      return { "typescript.worker.libEdition": value("derived", "es2025") };
    case SCOPE_TYPESCRIPT_LIBRARIES:
      return { "typescript.editions": value("observed", ["es2025"]) };
    case SCOPE_LAUNCHER_PERMISSIONS:
      return { "launcher.vite-build": value("derived", ["--allow-read"]) };
    default:
      return { "vite.build.targets": value("observed", ["chrome111"]) };
  }
}

/** Build a valid v2 lock whose fingerprints match `who`. */
async function makeLock(who = identity()) {
  const mirror = contractInputs(who);
  const contracts = {};

  for (const scope of SCOPES) {
    const inputs = fingerprintInputs(scope, mirror);
    const fingerprint = await fingerprintOf(inputs);
    contracts[contractKey(scope, fingerprint)] = {
      scope,
      fingerprint,
      fingerprintInputs: inputs,
      values: scopeValues(scope),
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    toolchain: { deno: { version: Deno.version.deno } },
    contracts,
  };
}

describe("v2 lock schema", () => {
  it("accepts a lock whose keys match their scope and fingerprint", async () => {
    const document = await makeLock();
    validateDocument(document);
    assert.equal(document.schemaVersion, 2);
  });

  it("exposes exactly the three conformance statuses", () => {
    assert.deepEqual([...CONTRACT_STATUSES], [
      "recorded",
      "drifted",
      "unrecorded",
    ]);
  });

  it("rejects v1 lifecycle metadata by name", async () => {
    const document = await makeLock();
    const [key] = Object.keys(document.contracts);

    for (const field of ["state", "approved", "bootstrap"]) {
      const copy = structuredClone(document);
      copy.contracts[key][field] = field === "state" ? "approved" : {};
      assert.throws(
        () => validateDocument(copy),
        /v1 lifecycle metadata/,
        `${field} must be rejected`,
      );
    }

    const withPolicies = structuredClone(document);
    withPolicies.policies = {};
    assert.throws(
      () => validateDocument(withPolicies),
      /v1 lifecycle metadata/,
    );
  });

  it("rejects unknown fields and unapproved provenance names", async () => {
    const document = await makeLock();
    const [key] = Object.keys(document.contracts);

    const extra = structuredClone(document);
    extra.contracts[key].reviewedBy = "someone";
    assert.throws(() => validateDocument(extra), /unknown field/);

    const declared = structuredClone(document);
    declared.contracts[key].values["x"] = value("declared");
    assert.throws(() => validateDocument(declared), /expected one of/);
  });

  it("rejects a key that does not match its scope and fingerprint", async () => {
    const document = await makeLock();
    const [key] = Object.keys(document.contracts);
    const copy = structuredClone(document);
    copy.contracts[`${key}-tampered`] = copy.contracts[key];
    delete copy.contracts[key];

    assert.throws(() => validateDocument(copy), /does not match its scope/);
  });

  it("refuses a v1 document and names the refresh command", () => {
    assert.throws(
      () =>
        validateDocument({ schemaVersion: 1, toolchain: {}, contracts: {} }),
      /contract:refresh/,
    );
  });
});

describe("conformance report", () => {
  it("reports every scope as recorded when the derivation matches", async () => {
    const document = await makeLock();
    const report = await buildConformanceReport({
      document,
      identity: identity(),
      digest: "sha256:lock",
    });

    assert.equal(report.verdict, "conformant");
    assert.deepEqual(report.problems, []);
    assert.equal(report.scopes.length, SCOPES.length);
    for (const entry of report.scopes) {
      assert.equal(entry.status, "recorded", summariseScope(entry));
      assert.equal(entry.recordedFingerprint, entry.derivedFingerprint);
    }
  });

  it("distinguishes a changed contract from a missing one", async () => {
    const who = identity();
    const document = await makeLock(who);

    // Changed: a legitimate configuration input moved, so the derivation no
    // longer reproduces the recorded fingerprint.
    const drifted = await buildConformanceReport({
      document,
      identity: {
        ...who,
        vite: { ...who.vite, buildTarget: "chrome111" },
      },
      digest: "sha256:lock",
    });

    assert.equal(drifted.verdict, "drifted");
    const viteScope = drifted.scopes.find((entry) =>
      entry.scope === SCOPE_VITE_TARGET
    );
    assert.equal(viteScope.status, "drifted");
    assert.equal(
      viteScope.derivedFingerprint === viteScope.recordedFingerprint,
      false,
    );
    assert.deepEqual(
      viteScope.changedInputs.map((entry) => entry.name),
      ["buildTarget"],
    );
    assert.match(drifted.problems.join(" "), /has drifted/);

    // Internally inconsistent: the key is current but the recorded inputs are
    // not, which is what a hand-edited lock looks like.
    const tampered = structuredClone(document);
    const viteEntry = Object.entries(tampered.contracts).find(
      ([, contract]) => contract.scope === SCOPE_VITE_TARGET,
    );
    tampered.contracts[viteEntry[0]].fingerprintInputs.buildTarget =
      "chrome111";

    const inconsistent = await buildConformanceReport({
      document: tampered,
      identity: who,
    });
    assert.match(inconsistent.problems.join(" "), /internally inconsistent/);

    // Missing: the contract for a scope is absent altogether.
    const missing = await makeLock(who);
    for (const [key, contract] of Object.entries(missing.contracts)) {
      if (contract.scope === SCOPE_LAUNCHER_PERMISSIONS) {
        delete missing.contracts[key];
      }
    }

    const unrecorded = await buildConformanceReport({
      document: missing,
      identity: who,
      digest: "sha256:lock",
    });

    const launcherScope = unrecorded.scopes.find((entry) =>
      entry.scope === SCOPE_LAUNCHER_PERMISSIONS
    );
    assert.equal(launcherScope.status, "unrecorded");
    assert.equal(launcherScope.recordedFingerprint, null);
    assert.match(unrecorded.problems.join(" "), /is unrecorded/);
  });

  it("keeps the report itself deterministic", async () => {
    const document = await makeLock();
    const first = await buildConformanceReport({
      document,
      identity: identity(),
      digest: "sha256:lock",
    });
    const second = await buildConformanceReport({
      document,
      identity: identity(),
      digest: "sha256:lock",
    });

    assert.equal(canonicalJson(first), canonicalJson(second));
  });
});

describe("generated configuration", () => {
  it("compares the built configuration with the recorded values", async () => {
    const root = makeRoot();
    const document = await makeLock();
    const runtime = Object.values(document.contracts).find((contract) =>
      contract.scope === SCOPE_WORKERD_RUNTIME
    );
    runtime.values["runtime.compatibility.date"] = {
      kind: "configuration",
      value: "2026-10-30",
      provenance: "authoritative",
      evidence: "wrangler.jsonc",
    };
    runtime.values["runtime.compatibility.flags"] = {
      kind: "configuration",
      value: [],
      provenance: "authoritative",
      evidence: "wrangler.jsonc",
    };

    assert.deepEqual(generatedConfigProblems(root, runtime), []);

    write(root, "dist/worker/wrangler.json", {
      compatibility_date: "2026-01-01",
      compatibility_flags: [],
    });

    assert.match(
      generatedConfigProblems(root, runtime).join(" "),
      /compatibility_date/,
    );
  });
});

describe("product boundary", () => {
  it("enforces the recorded Deno version in the product too", async () => {
    const document = await makeLock();

    assert.deepEqual(denoProblems(document), []);
    assert.match(
      denoProblems(document, "9.9.9").join(" "),
      /records Deno .*but this process is Deno 9\.9\.9/,
    );
  });

  it("has no authoring command and imports no authoring module", async () => {
    const { main } = await import("./contracts/cli.mjs");

    for (const command of ["refresh", "approve", "discover", "accept"]) {
      const lines = [];
      const io = {
        log: (line) => lines.push(line),
        error: (line) => lines.push(line),
      };
      const code = await main([command], makeRoot(), io);

      assert.equal(code, 1, `${command} must not exist`);
      assert.match(lines.join(" "), /unknown command/);
    }

    const source = readFileSync(
      path.join(projectRoot, "scripts/contracts/cli.mjs"),
      "utf8",
    );
    for (
      const forbidden of [
        "./discover.mjs",
        "./author-cli.mjs",
        "./fixtures.mjs",
        "./workerd-probe.mjs",
      ]
    ) {
      assert.equal(source.includes(forbidden), false, `${forbidden} imported`);
    }
  });

  it("verifies under a read-only launcher profile", () => {
    const script = readFileSync(
      path.join(projectRoot, "scripts/check-contracts.sh"),
      "utf8",
    );

    assert.match(script, /--allow-read=/);
    assert.match(script, /--allow-env/);
    assert.match(script, /scripts\/contracts\/cli\.mjs verify/);
    for (
      const forbidden of [
        "--allow-write",
        "--allow-run",
        "--allow-net",
        "--allow-ffi",
        "--allow-all",
      ]
    ) {
      assert.equal(
        script.includes(forbidden),
        false,
        `the conformance launcher must not grant ${forbidden}`,
      );
    }
  });
});
