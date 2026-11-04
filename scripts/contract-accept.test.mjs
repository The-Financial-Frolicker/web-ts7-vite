/**
 * Product-side contract acceptance tests.
 *
 * Acceptance installs an *already approved* artefact. It is not approval, and
 * these tests prove it cannot become approval: bootstrap and candidate
 * artefacts are refused, mismatched approvals are refused, and the installed
 * file is the one a human approved elsewhere.
 *
 * Trust boundary: the artefact is trusted because it arrives through a reviewed
 * delivery process. Its approval record is metadata, not a cryptographic proof.
 */
import assert from "./lib/assert.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";

import { main } from "./contracts/cli.mjs";
import { contractKey } from "./contracts/canonical.mjs";
import { SCOPE_WORKERD_RUNTIME } from "./contracts/scopes.mjs";

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "accept-"));
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

function artefact(state = "approved", fingerprint = "sha256:aaaa") {
  const contract = {
    scope: SCOPE_WORKERD_RUNTIME,
    fingerprint: "sha256:aaaa",
    fingerprintInputs: {
      workerd: "1.20261023.1",
      compatibilityDate: "2026-10-30",
      compatibilityFlags: [],
      platform: "linux-x64",
    },
    state,
    approved: null,
    bootstrap: null,
    values: {
      "runtime.compatibility.date": {
        kind: "configuration",
        value: "2026-10-30",
        provenance: "authoritative",
        evidence: "wrangler.jsonc",
      },
    },
  };

  if (state === "approved") {
    contract.approved = {
      by: "delivered",
      at: "2026-01-01T00:00:00.000Z",
      reason: "approved upstream",
      fingerprint,
    };
  }
  if (state === "bootstrap") {
    contract.bootstrap = { at: "2026-01-01T00:00:00.000Z", reason: "carried" };
  }

  return {
    schemaVersion: 1,
    toolchain: {},
    contracts: { [RUNTIME_KEY]: contract },
    policies: {},
  };
}

/** Run the product CLI, capturing output instead of printing it. */
async function run(root, argv) {
  const lines = [];
  const io = { log: (m) => lines.push(m), error: (m) => lines.push(m) };
  const code = await main(argv, root, io);
  return { code, output: lines.join("\n") };
}

describe("product contract acceptance", () => {
  it("installs an approved, internally consistent artefact", async () => {
    const root = makeRoot();
    write(root, "incoming.json", artefact());

    const result = await run(root, ["accept", "--from", "incoming.json"]);

    assert.equal(result.code, 0, result.output);
    const installed = JSON.parse(
      readFileSync(path.join(root, "toolchain-contracts.json"), "utf8"),
    );
    assert.equal(installed.contracts[RUNTIME_KEY].state, "approved");
    assert.equal(
      installed.contracts[RUNTIME_KEY].approved.fingerprint,
      "sha256:aaaa",
    );
  });

  it("refuses bootstrap and candidate artefacts", async () => {
    for (const state of ["bootstrap", "candidate"]) {
      const root = makeRoot();
      write(root, "incoming.json", artefact(state));

      const result = await run(root, ["accept", "--from", "incoming.json"]);

      assert.equal(result.code, 1, `${state} must be refused`);
      assert.match(result.output, /never creates one|not approved/);
      assert.equal(
        existsSync(path.join(root, "toolchain-contracts.json")),
        false,
      );
    }
  });

  it("leaves an installed contract untouched when input is rejected", async () => {
    const root = makeRoot();
    const installed = artefact();
    write(root, "toolchain-contracts.json", installed);
    const file = path.join(root, "toolchain-contracts.json");
    const before = readFileSync(file, "utf8");

    write(root, "incoming.json", artefact("bootstrap"));
    const rejected = await run(root, ["accept", "--from", "incoming.json"]);

    assert.equal(rejected.code, 1);
    assert.equal(readFileSync(file, "utf8"), before);

    write(root, "incoming.json", artefact("approved", "sha256:deadbeef"));
    assert.equal(
      (await run(root, ["accept", "--from", "incoming.json"])).code,
      1,
    );
    assert.equal(readFileSync(file, "utf8"), before);
  });

  it("refuses an approval bound to another fingerprint", async () => {
    const root = makeRoot();
    write(root, "incoming.json", artefact("approved", "sha256:deadbeef"));

    const result = await run(root, ["accept", "--from", "incoming.json"]);

    assert.equal(result.code, 1);
    assert.match(result.output, /fingerprint/);
    assert.equal(
      existsSync(path.join(root, "toolchain-contracts.json")),
      false,
    );
  });

  it("refuses an incompatible schema version", async () => {
    const root = makeRoot();
    const incoming = artefact();
    incoming.schemaVersion = 99;
    write(root, "incoming.json", incoming);

    const result = await run(root, ["accept", "--from", "incoming.json"]);

    assert.equal(result.code, 1);
    assert.match(result.output, /schemaVersion/);
  });

  it("leaves application files untouched", async () => {
    const root = makeRoot();
    write(root, "worker/index.ts", "export default {};");
    write(root, "incoming.json", artefact());

    assert.equal(
      (await run(root, ["accept", "--from", "incoming.json"])).code,
      0,
    );
    assert.equal(
      readFileSync(path.join(root, "worker/index.ts"), "utf8"),
      "export default {};",
    );
  });

  it("makes the accepted artefact the one the verifier reads", async () => {
    const root = makeRoot();
    write(root, "incoming.json", artefact());
    assert.equal((await run(root, ["status"])).code, 1);

    assert.equal(
      (await run(root, ["accept", "--from", "incoming.json"])).code,
      0,
    );
    const status = await run(root, ["status"]);

    assert.equal(status.code, 0, status.output);
    assert.match(status.output, /approved/);
  });

  it("has no product-side command that creates or promotes an approval", async () => {
    for (const command of ["approve", "discover"]) {
      const result = await run(makeRoot(), [command]);
      assert.equal(result.code, 1, `${command} must not exist`);
      assert.match(result.output, /unknown command/);
    }
  });
});
