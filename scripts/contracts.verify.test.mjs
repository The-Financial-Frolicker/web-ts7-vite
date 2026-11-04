/**
 * Product-side contract tests.
 *
 * This suite ships in the generated product. It covers what a product can do:
 * enforce lifecycle state, bind approvals to fingerprints, check generated
 * configuration, and accept an externally approved artefact. It contains no
 * discovery or approval tests, because the product contains no such machinery.
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

import { contractKey } from "./contracts/canonical.mjs";
import {
  CONTRACT_STATES,
  isApproved,
  unapprovedContracts,
  validateDocument,
} from "./contracts/schema.mjs";
import { SCOPE_WORKERD_RUNTIME } from "./contracts/scopes.mjs";
import { generatedConfigProblems } from "./contracts/verify.mjs";

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

const RUNTIME_KEY = contractKey(SCOPE_WORKERD_RUNTIME, "sha256:aaaa");

function contract(state) {
  const base = {
    scope: SCOPE_WORKERD_RUNTIME,
    fingerprint: "sha256:aaaa",
    fingerprintInputs: {
      workerd: "1.20261023.1",
      compatibilityDate: "2026-10-30",
      compatibilityFlags: [],
      platform: "linux-x64",
    },
    values: {
      "runtime.compatibility.date": {
        kind: "configuration",
        value: "2026-10-30",
        provenance: "authoritative",
        evidence: "wrangler.jsonc",
      },
      "runtime.compatibility.flags": {
        kind: "configuration",
        value: [],
        provenance: "authoritative",
        evidence: "wrangler.jsonc",
      },
    },
    approved: null,
    bootstrap: null,
  };

  if (state === "approved") {
    return {
      ...base,
      state,
      approved: {
        by: "a-human",
        at: "2026-01-01T00:00:00.000Z",
        reason: "reviewed",
        fingerprint: "sha256:aaaa",
      },
    };
  }
  if (state === "bootstrap") {
    return {
      ...base,
      state,
      bootstrap: { at: "2026-01-01T00:00:00.000Z", reason: "provisional" },
    };
  }

  return { ...base, state: "candidate" };
}

function document(state) {
  return {
    schemaVersion: 1,
    toolchain: {},
    contracts: { [RUNTIME_KEY]: contract(state) },
    policies: {},
  };
}

describe("product contract lifecycle", () => {
  it("supports exactly the three declared states", () => {
    assert.deepEqual([...CONTRACT_STATES], [
      "candidate",
      "bootstrap",
      "approved",
    ]);
  });

  it("rejects bootstrap and candidate contracts", () => {
    for (const state of ["bootstrap", "candidate"]) {
      const doc = document(state);
      validateDocument(doc);
      assert.equal(isApproved(doc.contracts[RUNTIME_KEY]), false);
      assert.deepEqual(unapprovedContracts(doc), [RUNTIME_KEY]);
    }
  });

  it("accepts an approval bound to the contract fingerprint", () => {
    const doc = document("approved");
    validateDocument(doc);
    assert.equal(isApproved(doc.contracts[RUNTIME_KEY]), true);
    assert.deepEqual(unapprovedContracts(doc), []);
  });

  it("rejects an approval carried over from another fingerprint", () => {
    const doc = document("approved");
    doc.contracts[RUNTIME_KEY].fingerprint = "sha256:bbbb";

    assert.equal(isApproved(doc.contracts[RUNTIME_KEY]), false);
    assert.throws(() => validateDocument(doc), /bound to one fingerprint/);
  });

  it("rejects an approval with no approver or reason", () => {
    for (const field of ["by", "reason"]) {
      const doc = document("approved");
      doc.contracts[RUNTIME_KEY].approved[field] = "";
      assert.throws(
        () => validateDocument(doc),
        new RegExp(`approved\\.${field}`),
      );
    }
  });
});

describe("generated configuration", () => {
  it("compares the built configuration with the contract", () => {
    const root = makeRoot();
    const runtime = document("approved").contracts[RUNTIME_KEY];

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

describe("product module boundary", () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");

  it("product CLI has no authoring imports", () => {
    const source = readFileSync(
      path.join(projectRoot, "scripts/contracts/cli.mjs"),
      "utf8",
    );

    for (
      const forbidden of [
        "./discover.mjs",
        "./approve.mjs",
        "./fixtures.mjs",
        "./workerd-probe.mjs",
      ]
    ) {
      assert.equal(source.includes(forbidden), false, `${forbidden} imported`);
    }
  });
});
