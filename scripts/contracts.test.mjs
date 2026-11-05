/**
 * Tests for the two-phase contract architecture.
 *
 * Everything here runs on synthetic fixtures: no workerd, no Vite, no installed
 * npm packages. The properties under test are the ones CI depends on — stable
 * fingerprints, strict provenance, refusal to approve uncertainty, refusal to
 * overwrite silently, and policy review that cannot be bypassed by a toolchain
 * change.
 */
import assert from "./lib/assert.mjs";
import { run } from "./lib/command.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import {
  readLibs,
  readWranglerConfig,
  stripJsonc,
} from "./contracts/config.mjs";
import {
  deriveWorkerLibEdition,
  fingerprintInputs,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_VITE_TARGET,
  SCOPE_WORKERD_RUNTIME,
} from "./contracts/discover.mjs";
import { probeConfigSource, probeWorkerSource } from "./contracts/fixtures.mjs";
import {
  describePermissionProfiles,
  normalisePermissionFlags,
} from "./contracts/permissions.mjs";
import {
  CONTRACT_STATES,
  isApproved,
  unapprovedContracts,
  unverifiedValues,
  validateDocument,
} from "./contracts/schema.mjs";
import { approveCandidate, buildPolicies } from "./contracts/approve.mjs";
import {
  mapProbeOutcome,
  parseHttpResponse,
} from "./contracts/workerd-probe.mjs";
import {
  clientEditionProblems,
  declaredEdition,
  describeUnapproved,
  findContract,
  generatedConfigProblems,
  policyProblems,
} from "./contracts/verify.mjs";

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(prefix = "contracts-") {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
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

/** A minimal value entry with a chosen provenance. */
function value(provenance, v = true) {
  return { kind: "capability", value: v, provenance, evidence: "test fixture" };
}

/** Lifecycle fields for an explicitly approved contract. */
function approvedRecord(fingerprint) {
  return {
    state: "approved",
    approved: {
      by: "reviewer",
      at: "2026-01-01T00:00:00.000Z",
      reason: "test",
      fingerprint,
    },
    bootstrap: null,
  };
}

/** A contract document with one approved contract per scope. */
function makeDocument(overrides = {}) {
  const runtimeValues = overrides.runtimeValues ?? {
    "typescript.worker.libEdition": value("derived", "es2023"),
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
  };

  const contracts = {
    [contractKey(SCOPE_WORKERD_RUNTIME, "sha256:aaaa")]: {
      scope: SCOPE_WORKERD_RUNTIME,
      fingerprint: "sha256:aaaa",
      fingerprintInputs: {
        workerd: "1.0.0",
        compatibilityDate: "2026-10-30",
        compatibilityFlags: [],
        platform: "linux-x64",
      },
      ...approvedRecord("sha256:aaaa"),
      values: runtimeValues,
    },
    [contractKey(SCOPE_VITE_TARGET, "sha256:bbbb")]: {
      scope: SCOPE_VITE_TARGET,
      fingerprint: "sha256:bbbb",
      fingerprintInputs: { vite: "1.0.0", platform: "linux-x64" },
      ...approvedRecord("sha256:bbbb"),
      values: { "vite.build.targets": value("observed", ["chrome120"]) },
    },
    [contractKey(SCOPE_TYPESCRIPT_LIBRARIES, "sha256:cccc")]: {
      scope: SCOPE_TYPESCRIPT_LIBRARIES,
      fingerprint: "sha256:cccc",
      fingerprintInputs: { typescript: "1.0.0", platform: "linux-x64" },
      ...approvedRecord("sha256:cccc"),
      values: {
        "typescript.editions": value("observed", [
          "es2022",
          "es2023",
          "esnext",
        ]),
        "typescript.libraries": value("observed", ["dom"]),
      },
    },
  };

  return {
    schemaVersion: 1,
    toolchain: {},
    contracts,
    policies: {
      clientApiEdition: {
        provenance: "declared",
        value: "es2023",
        rationale: "test",
        decidedBy: "reviewer",
        decidedAt: "2026-01-01T00:00:00.000Z",
        reviewedAgainst: Object.keys(contracts),
        checkedAgainst: ["tsconfig.json compilerOptions.lib"],
      },
      permissionProfiles: {
        provenance: "declared",
        value: { "vite-build": ["--allow-read"] },
        rationale: "test",
        decidedBy: "reviewer",
        decidedAt: "2026-01-01T00:00:00.000Z",
        reviewedAgainst: Object.keys(contracts),
        checkedAgainst: ["scripts/vite-build.mjs buildViteArgs"],
      },
    },
  };
}

describe("canonical serialisation", () => {
  it("sorts object keys so logically equal values serialise identically", () => {
    assert.equal(
      canonicalJson({ b: 1, a: { d: 2, c: 3 } }, 0),
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }, 0),
    );
  });

  it("preserves array order because it is meaningful", () => {
    assert.equal(canonicalJson(["a", "b"], 0), '["a","b"]');
    assert.equal(canonicalJson(["b", "a"], 0), '["b","a"]');
  });

  it("fingerprints are stable across key order and change with input", async () => {
    const first = await fingerprintOf({ workerd: "1", platform: "linux" });
    const reordered = await fingerprintOf({ platform: "linux", workerd: "1" });
    const different = await fingerprintOf({ workerd: "2", platform: "linux" });

    assert.equal(first, reordered);
    assert.equal(first.startsWith("sha256:"), true);
    assert.equal(first === different, false);
  });

  it("keys a contract by scope and fingerprint", () => {
    assert.equal(
      contractKey("workerd-runtime", "sha256:abc"),
      "workerd-runtime@sha256:abc",
    );
  });
});

describe("JSONC configuration readers", () => {
  it("strips comments without touching strings that contain comment markers", () => {
    const text = `{
      // line comment
      "url": "https://example.test/a//b",
      /* block comment */
      "literal": "// not a comment",
    }`;

    const parsed = JSON.parse(stripJsonc(text));
    assert.equal(parsed.url, "https://example.test/a//b");
    assert.equal(parsed.literal, "// not a comment");
  });

  it("drops trailing commas in objects and arrays", () => {
    const parsed = JSON.parse(stripJsonc('{ "a": [1, 2,], "b": 3, }'));
    assert.deepEqual(parsed, { a: [1, 2], b: 3 });
  });

  it("reads lib lists and rejects a non-array", () => {
    const root = makeRoot();
    write(
      root,
      "tsconfig.json",
      '{ "compilerOptions": { "lib": ["ES2023", "DOM"] } }',
    );
    assert.deepEqual(readLibs(root, "tsconfig.json"), ["ES2023", "DOM"]);

    write(root, "bad.json", '{ "compilerOptions": { "lib": "ES2023" } }');
    assert.throws(() => readLibs(root, "bad.json"), /must be an array/);
  });

  it("reads Wrangler compatibility settings and requires a date", () => {
    const root = makeRoot();
    write(
      root,
      "wrangler.jsonc",
      '{ // comment\n "compatibility_date": "2026-10-30", "compatibility_flags": ["nodejs_compat"], }',
    );

    const config = readWranglerConfig(root);
    assert.equal(config.compatibilityDate, "2026-10-30");
    assert.deepEqual(config.compatibilityFlags, ["nodejs_compat"]);

    write(root, "wrangler.jsonc", '{ "name": "x" }');
    assert.throws(() => readWranglerConfig(root), /compatibility_date/);
  });
});

describe("schema validation", () => {
  it("accepts a well-formed document", () => {
    validateDocument(makeDocument());
  });

  it("rejects an unknown provenance value", () => {
    const document = makeDocument({
      runtimeValues: { "typescript.worker.libEdition": value("guessed") },
    });
    assert.throws(() => validateDocument(document), /expected one of/);
  });

  it("rejects a policy that discovery could have produced", () => {
    const document = makeDocument();
    document.policies.clientApiEdition.provenance = "observed";
    assert.throws(
      () => validateDocument(document),
      /must have provenance "declared"/,
    );
  });

  it("lists unverified values", () => {
    const contract = makeDocument({
      runtimeValues: {
        "a": value("observed"),
        "b": value("unverified"),
      },
    }).contracts[contractKey(SCOPE_WORKERD_RUNTIME, "sha256:aaaa")];

    assert.deepEqual(unverifiedValues(contract), ["b"]);
  });

  it("rejects a document from a different schema version", () => {
    const document = makeDocument();
    document.schemaVersion = 99;
    assert.throws(() => validateDocument(document), /schemaVersion/);
  });
});

describe("fingerprint inputs", () => {
  const identity = {
    platform: "linux-x64",
    workerd: {
      version: "1.2.3",
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["x"],
    },
    vite: { version: "8.0.0" },
    typescript: { version: "7.0.2" },
  };

  it("includes only the inputs that can change that contract", () => {
    assert.deepEqual(
      Object.keys(fingerprintInputs(SCOPE_WORKERD_RUNTIME, identity)).sort(),
      ["compatibilityDate", "compatibilityFlags", "platform", "workerd"],
    );
    assert.deepEqual(
      Object.keys(fingerprintInputs(SCOPE_VITE_TARGET, identity)).sort(),
      ["platform", "vite"],
    );
    assert.deepEqual(
      Object.keys(fingerprintInputs(SCOPE_TYPESCRIPT_LIBRARIES, identity))
        .sort(),
      ["platform", "typescript"],
    );
  });

  it("does not invalidate a runtime contract when only Vite changes", async () => {
    const before = await fingerprintOf(
      fingerprintInputs(SCOPE_WORKERD_RUNTIME, identity),
    );
    const after = await fingerprintOf(
      fingerprintInputs(SCOPE_WORKERD_RUNTIME, {
        ...identity,
        vite: { version: "9.0.0" },
      }),
    );

    assert.equal(before, after);
  });
});

describe("worker edition derivation", () => {
  const editionIds = [
    "es2015.core",
    "es2016.array.includes",
    "es2017.object.entries",
    "es2018.promise.finally",
    "es2019.object.fromEntries",
    "es2020.bigint",
    "es2021.promise.any",
    "es2022.object.hasOwn",
    "es2023.array.toSorted",
    "es2024.object.groupBy",
    "es2025.set.union",
  ];

  function results(outcome = "supported", overrides = {}) {
    const entries = {};
    for (const id of editionIds) {
      entries[id] = { outcome: overrides[id] ?? outcome };
    }
    return entries;
  }

  it("claims the newest edition when every probe is supported", () => {
    const derived = deriveWorkerLibEdition(results());

    assert.equal(derived.edition, "es2025");
    assert.equal(derived.provenance, "derived");
  });

  it("stops at the newest fully supported edition", () => {
    const derived = deriveWorkerLibEdition(
      results("supported", { "es2024.object.groupBy": "unsupported" }),
    );

    assert.equal(derived.edition, "es2023");
    assert.equal(derived.provenance, "derived");
    assert.match(derived.evidence, /es2024\.object\.groupBy unsupported/);
  });

  it("never reads a failed probe as an unsupported capability", () => {
    const derived = deriveWorkerLibEdition(
      results("supported", { "es2024.object.groupBy": "probe-failed" }),
    );

    assert.equal(derived.provenance, "unverified");
    assert.equal(derived.edition, "es2023");
    assert.match(derived.evidence, /could not establish a result/);
  });

  it("is unverified when even the oldest edition cannot be claimed", () => {
    const derived = deriveWorkerLibEdition(
      results("supported", { "es2015.core": "unsupported" }),
    );

    assert.equal(derived.edition, null);
    assert.equal(derived.provenance, "unverified");
  });
});

describe("probe plumbing", () => {
  it("maps results to three distinct outcomes", () => {
    assert.equal(mapProbeOutcome({ ok: true }).outcome, "supported");
    assert.equal(mapProbeOutcome({ ok: false }).outcome, "unsupported");
    assert.equal(
      mapProbeOutcome({ ok: false, error: "TypeError" }).outcome,
      "probe-failed",
    );
    assert.equal(mapProbeOutcome(undefined).outcome, "probe-failed");
    assert.equal(mapProbeOutcome({ ok: "yes" }).outcome, "probe-failed");
  });

  it("parses a content-length response", () => {
    const response = parseHttpResponse(
      'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"results":{}}',
    );

    assert.equal(response.status, 200);
    assert.equal(response.body, '{"results":{}}');
  });

  it("decodes a chunked response", () => {
    const body = '6\r\n{"a":1\r\n0\r\n\r\n';
    const response = parseHttpResponse(
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body}`,
    );

    assert.equal(response.body, '{"a":1');
  });

  it("rejects a response without a status line", () => {
    assert.throws(() => parseHttpResponse("nonsense"), /status line|header/);
  });

  it("generates a worker that evaluates every catalogue entry", () => {
    const source = probeWorkerSource();
    assert.match(source, /es2025\.set\.union/);
    assert.match(source, /runtime\.webcrypto/);
    assert.match(source, /catch \(error\)/);
  });

  it("refuses to embed a configuration value it cannot escape safely", () => {
    assert.throws(
      () =>
        probeConfigSource({
          port: 8080,
          compatibilityDate: '2026-10-30"; }\n',
        }),
      /cannot embed safely/,
    );

    const config = probeConfigSource({
      port: 8080,
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["nodejs_compat"],
    });
    assert.match(config, /compatibilityDate = "2026-10-30"/);
    assert.match(config, /"nodejs_compat"/);
    assert.match(config, /127\.0\.0\.1:8080/);
  });
});

describe("permission policy normalisation", () => {
  const root = "/home/someone/project";

  it("replaces machine-specific paths with stable placeholders", () => {
    const flags = normalisePermissionFlags(
      [
        "run",
        "--allow-read",
        "--allow-write=/home/someone/project/dist/worker",
        "--allow-run=/usr/local/bin/workerd",
      ],
      root,
    );

    assert.deepEqual(flags, [
      "--allow-read",
      "--allow-write=<root>/dist/worker",
      "--allow-run=<path>/workerd",
    ]);
  });

  it("produces the same policy on a different machine", () => {
    const other = "/opt/checkout";
    const first = normalisePermissionFlags(
      ["--allow-ffi=/a/b/rolldown.node"],
      root,
    );
    const second = normalisePermissionFlags(
      ["--allow-ffi=/x/y/rolldown.node"],
      other,
    );

    assert.deepEqual(first, second);
  });

  it("describes both named Vite profiles", () => {
    const profiles = describePermissionProfiles(root);

    assert.deepEqual(profiles["vite-build"], [
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-sys",
      "--allow-ffi=<rolldown>",
      "--allow-ffi=<lightningcss>",
    ]);
    assert.deepEqual(profiles["vite-build-ci-runner"], ["--allow-all"]);

    // Both launchers are still recorded, so a change to either is a policy
    // change rather than an unnoticed edit.
    assert.ok(profiles["wrangler-types"].length > 0);
    assert.ok(profiles["wrangler-dry-run"].length > 0);
  });
});

describe("approval", () => {
  const runtimeKey = contractKey(SCOPE_WORKERD_RUNTIME, "sha256:aaaa");

  function candidate() {
    const document = makeDocument();
    document.policies = {};
    for (const contract of Object.values(document.contracts)) {
      contract.state = "candidate";
      contract.approved = null;
      contract.bootstrap = null;
    }
    return document;
  }

  const base = {
    by: "reviewer",
    reason: "reviewed",
    at: "2026-02-02T00:00:00.000Z",
    root: "/tmp",
  };

  it("refuses a candidate containing an unverified value", () => {
    const document = candidate();
    document.contracts[runtimeKey].values["runtime.probe"] = value(
      "unverified",
    );

    assert.throws(
      () =>
        approveCandidate({
          ...base,
          existing: makeDocument(),
          candidate: document,
          replace: true,
          clientApiEdition: "es2023",
        }),
      /unverified values/,
    );
  });

  it("requires a named approver and a stated reason", () => {
    assert.throws(
      () =>
        approveCandidate({
          ...base,
          by: "  ",
          existing: makeDocument(),
          candidate: candidate(),
          replace: true,
        }),
      /named approver/,
    );
    assert.throws(
      () =>
        approveCandidate({
          ...base,
          reason: "",
          existing: makeDocument(),
          candidate: candidate(),
          replace: true,
        }),
      /stated reason/,
    );
  });

  it("refuses to overwrite an approved contract without --replace", () => {
    assert.throws(
      () =>
        approveCandidate({
          ...base,
          existing: makeDocument(),
          candidate: candidate(),
          clientApiEdition: "es2023",
        }),
      /already approved/,
    );
  });

  it("carries policies forward verbatim when not reaffirming", () => {
    const existing = makeDocument();
    const approved = approveCandidate({
      ...base,
      existing,
      candidate: candidate(),
      replace: true,
    });

    assert.deepEqual(approved.policies, existing.policies);
  });

  it("rebuilds policy review links when reaffirming", () => {
    const document = candidate();
    const approved = approveCandidate({
      ...base,
      existing: makeDocument(),
      candidate: document,
      replace: true,
      reaffirm: true,
      clientApiEdition: "es2022",
    });

    assert.equal(approved.policies.clientApiEdition.value, "es2022");
    assert.deepEqual(
      [...approved.policies.clientApiEdition.reviewedAgainst].sort(),
      [
        contractKey(SCOPE_TYPESCRIPT_LIBRARIES, "sha256:cccc"),
        contractKey(SCOPE_VITE_TARGET, "sha256:bbbb"),
      ].sort(),
    );
    assert.deepEqual(
      approved.policies.permissionProfiles.reviewedAgainst,
      [contractKey(SCOPE_WORKERD_RUNTIME, "sha256:aaaa")],
    );
  });

  it("requires an explicit declared edition when policies are created", () => {
    assert.throws(
      () =>
        buildPolicies({
          contracts: candidate().contracts,
          by: "reviewer",
          at: base.at,
          clientApiEdition: undefined,
          root: "/tmp",
        }),
      /declared client API edition is required/,
    );
  });

  it("keeps every pre-existing contract when adding a new fingerprint", () => {
    const existing = makeDocument();
    const document = candidate();
    delete document.contracts[runtimeKey];

    const approved = approveCandidate({
      ...base,
      existing,
      candidate: document,
      replace: true,
    });

    assert.deepEqual(
      Object.keys(approved.contracts).sort(),
      Object.keys(existing.contracts).sort(),
    );
    assert.deepEqual(approved.policies, existing.policies);
  });
});

describe("verification helpers", () => {
  it("normalises declared editions and picks the highest", () => {
    assert.equal(declaredEdition(["ES2023", "DOM"]), "es2023");
    assert.equal(declaredEdition(["ESNext"]), "esnext");
    assert.equal(declaredEdition(["DOM"]), null);
  });

  it("compares the generated configuration with the contract", () => {
    const root = makeRoot();
    const runtime = makeDocument().contracts[
      contractKey(SCOPE_WORKERD_RUNTIME, "sha256:aaaa")
    ];

    assert.deepEqual(generatedConfigProblems(root, runtime), []);

    write(root, "dist/worker/wrangler.json", {
      compatibility_date: "2026-01-01",
      compatibility_flags: [],
    });
    const problems = generatedConfigProblems(root, runtime);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /compatibility_date/);
  });

  it("flags a policy that was reviewed against a different contract", () => {
    const document = makeDocument();
    document.policies.clientApiEdition.reviewedAgainst = [
      "workerd-runtime@sha256:dead",
    ];

    const problems = policyProblems(document, {
      [SCOPE_WORKERD_RUNTIME]: {
        key: contractKey(SCOPE_WORKERD_RUNTIME, "sha256:aaaa"),
      },
      [SCOPE_VITE_TARGET]: {
        key: contractKey(SCOPE_VITE_TARGET, "sha256:bbbb"),
      },
      [SCOPE_TYPESCRIPT_LIBRARIES]: {
        key: contractKey(SCOPE_TYPESCRIPT_LIBRARIES, "sha256:cccc"),
      },
    }, "/tmp");

    assert.match(problems.join(" "), /not the current contract/);
  });

  it("flags a permission profile that drifted from the approved policy", () => {
    const document = makeDocument();
    const problems = policyProblems(
      document,
      {
        [SCOPE_WORKERD_RUNTIME]: {
          key: contractKey(SCOPE_WORKERD_RUNTIME, "sha256:aaaa"),
        },
      },
      "/tmp",
    );

    assert.match(problems.join(" "), /permission profiles declared by scripts/);
  });
});

describe("approval lifecycle", () => {
  const runtimeKey = contractKey(SCOPE_WORKERD_RUNTIME, "sha256:aaaa");

  it("exposes exactly three lifecycle states", () => {
    assert.deepEqual([...CONTRACT_STATES], [
      "candidate",
      "bootstrap",
      "approved",
    ]);
  });

  it("rejects a bootstrap contract as authoritatively approved", () => {
    const document = makeDocument();
    const contract = document.contracts[runtimeKey];
    contract.state = "bootstrap";
    contract.approved = null;
    contract.bootstrap = {
      at: "2026-01-01T00:00:00.000Z",
      reason: "provisional",
    };

    assert.equal(isApproved(contract), false);
    assert.deepEqual(unapprovedContracts(document), [runtimeKey]);
    assert.match(
      describeUnapproved(runtimeKey, contract),
      /bootstrap baseline/,
    );
    assert.match(
      describeUnapproved(runtimeKey, contract),
      /human must approve/,
    );
  });

  it("rejects a bootstrap contract that still claims an approver", () => {
    const document = makeDocument();
    const contract = document.contracts[runtimeKey];
    contract.state = "bootstrap";

    assert.throws(
      () => validateDocument(document),
      /only an explicit approval may record an approver/,
    );
  });

  it("rejects a candidate contract as approved", () => {
    const document = makeDocument();
    const contract = document.contracts[runtimeKey];
    contract.state = "candidate";
    contract.approved = null;

    assert.equal(isApproved(contract), false);
    assert.match(
      describeUnapproved(runtimeKey, contract),
      /unapproved candidate/,
    );
    validateDocument(document);
  });

  it("accepts an approval bound to the contract's own fingerprint", () => {
    const document = makeDocument();
    validateDocument(document);
    assert.equal(isApproved(document.contracts[runtimeKey]), true);
    assert.deepEqual(unapprovedContracts(document), []);
  });

  it("rejects an approval copied from another fingerprint", () => {
    const document = makeDocument();
    document.contracts[runtimeKey].approved.fingerprint = "sha256:deadbeef";

    assert.equal(isApproved(document.contracts[runtimeKey]), false);
    assert.throws(
      () => validateDocument(document),
      /an approval is bound to one fingerprint/,
    );
  });

  it("rejects an approval without an approver or a reason", () => {
    for (const field of ["by", "reason"]) {
      const document = makeDocument();
      document.contracts[runtimeKey].approved[field] = "";

      assert.throws(
        () => validateDocument(document),
        new RegExp(`approved\\.${field} must be a non-empty string`),
      );
    }
  });

  it("cannot be manufactured by discovery: approval is a separate act", () => {
    const discovered = makeDocument();
    for (const contract of Object.values(discovered.contracts)) {
      contract.state = "candidate";
      contract.approved = null;
      contract.bootstrap = null;
    }
    discovered.policies = {};

    // Discovery output is a valid document, but never an approved one.
    validateDocument(discovered);
    assert.equal(unapprovedContracts(discovered).length, 3);

    const approved = approveCandidate({
      existing: discovered,
      candidate: discovered,
      by: "reviewer",
      reason: "reviewed the evidence",
      at: "2026-02-02T00:00:00.000Z",
      clientApiEdition: "es2023",
      root: "/tmp",
    });

    for (const contract of Object.values(approved.contracts)) {
      assert.equal(contract.state, "approved");
      assert.equal(contract.approved.fingerprint, contract.fingerprint);
      assert.equal(contract.approved.by, "reviewer");
    }
    assert.equal(unapprovedContracts(approved).length, 0);
  });

  it("forces reaffirmation when promoting a bootstrap baseline", () => {
    const existing = makeDocument();
    for (const contract of Object.values(existing.contracts)) {
      contract.state = "bootstrap";
      contract.approved = null;
      contract.bootstrap = {
        at: "2026-01-01T00:00:00.000Z",
        reason: "provisional",
      };
    }
    for (const policy of Object.values(existing.policies)) {
      policy.decidedBy = "unrecorded (bootstrap)";
    }

    const approved = approveCandidate({
      existing,
      candidate: makeDocument(),
      by: "actual-human",
      reason: "promote provisional baseline",
      at: "2026-02-02T00:00:00.000Z",
      clientApiEdition: "es2023",
      root: "/tmp",
    });

    assert.equal(approved.policies.clientApiEdition.decidedBy, "actual-human");
    assert.equal(
      approved.policies.permissionProfiles.decidedBy,
      "actual-human",
    );
  });
});

describe("contract lookup and project boundary", () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");

  function absoluteStrings(value, where, offenders) {
    if (typeof value === "string") {
      if (value.startsWith("/")) offenders.push(`${where} = ${value}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        absoluteStrings(entry, `${where}[${index}]`, offenders)
      );
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        absoluteStrings(entry, `${where}.${key}`, offenders);
      }
    }
  }

  it("distinguishes a stale contract from an absent one", async () => {
    const document = makeDocument();
    const inputs = {
      workerd: {
        version: "9.9.9",
        compatibilityDate: "2026-10-30",
        compatibilityFlags: [],
      },
      platform: "linux-x64",
    };

    let stale = "";
    try {
      await findContract(document, SCOPE_WORKERD_RUNTIME, inputs);
    } catch (error) {
      stale = error.message;
    }
    assert.match(stale, /contract is stale/);
    assert.match(stale, /local discovery and approval cycle/);

    delete document.contracts[contractKey(SCOPE_VITE_TARGET, "sha256:bbbb")];
    let absent = "";
    try {
      await findContract(document, SCOPE_VITE_TARGET, {
        vite: { version: "1.0.0" },
        platform: "linux-x64",
      });
    } catch (error) {
      absent = error.message;
    }
    assert.match(absent, /no approved contract for scope vite-syntax-target/);
  });

  it("requires the declared client edition to exist in the compiler contract", () => {
    assert.deepEqual(
      clientEditionProblems({ value: "es2023" }, ["es2022", "es2023"]),
      [],
    );
    assert.match(
      clientEditionProblems({ value: "es2030" }, ["es2023"]).join(" "),
      /does not provide that edition/,
    );
    assert.deepEqual(clientEditionProblems(undefined, ["es2023"]), []);
    assert.deepEqual(clientEditionProblems({ value: "es2023" }, undefined), []);
  });

  // The approved artefact is committed and read in every clone, so a path from
  // the machine that authored it would make it machine-specific.
  it("commits an artefact with no machine-specific absolute paths", () => {
    const document = JSON.parse(
      readFileSync(path.join(projectRoot, "toolchain-contracts.json"), "utf8"),
    );
    const offenders = [];
    absoluteStrings(document, "document", offenders);

    assert.deepEqual(
      offenders,
      [],
      `absolute paths in the artefact: ${offenders.join("; ")}`,
    );
  });

  // The template is initialised in place, so the only generator-local state is
  // the discovery scratch directory; it must never become project content.
  it("keeps local discovery state out of the project", () => {
    const ignore = readFileSync(path.join(projectRoot, ".gitignore"), "utf8");
    assert.match(ignore, /^\/\.contracts\/$/m);
  });
});

describe("discovery entry point wiring", () => {
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const discoverScript = path.join(
    projectRoot,
    "scripts",
    "contract-discover.sh",
  );
  const hasDependencies = existsSync(
    path.join(projectRoot, "node_modules"),
  );

  /** Run the real shell entry point in `root`, exactly as the task does. */
  function runDiscover(root, args) {
    return run("/bin/bash", {
      args: [path.join(root, "scripts", "contract-discover.sh"), ...args],
      cwd: root,
      env: {
        ...Deno.env.toObject(),
        PATH: `${path.dirname(Deno.execPath())}:${Deno.env.get("PATH") ?? ""}`,
      },
    });
  }

  it("resolves the runtime through the generator authoring CLI", {
    skip: !hasDependencies,
  }, () => {
    // `--print-workerd` exercises the shell script, its Node-exclusion wrapper,
    // the Deno invocation and the CLI subcommand without probing anything.
    const result = runDiscover(projectRoot, ["--print-workerd"]);

    assert.equal(result.code, 0, result.stderr);
    const printed = result.stdout.trim();
    assert.match(printed, /\/bin\/workerd$/, printed);
    assert.equal(existsSync(printed), true, `${printed} does not exist`);
    assert.equal(
      (Deno.statSync(printed).mode & 0o111) !== 0,
      true,
      `${printed} is not executable`,
    );
  });

  it("targets the CLI that actually defines the subcommand", () => {
    const script = readFileSync(discoverScript, "utf8");
    assert.match(
      script,
      /scripts\/contracts\/author-cli\.mjs workerd-path/,
    );
    assert.doesNotMatch(
      script,
      /scripts\/contracts\/cli\.mjs workerd-path/,
    );

    // The distinction matters: only the generator-only authoring CLI defines
    // the subcommand, and the product CLI must keep having no discovery path.
    assert.match(
      readFileSync(
        path.join(projectRoot, "scripts", "contracts", "author-cli.mjs"),
        "utf8",
      ),
      /case "workerd-path"/,
    );
    assert.doesNotMatch(
      readFileSync(
        path.join(projectRoot, "scripts", "contracts", "cli.mjs"),
        "utf8",
      ),
      /"workerd-path"/,
    );
  });

  it("fails when the entry point is rewired to the product CLI", {
    skip: !hasDependencies,
  }, () => {
    // Shadow root holding the real modules and dependencies plus a deliberately
    // rewired copy of the script: the original defect, reproduced safely. The
    // positive test above cannot pass unless the wiring is correct.
    const shadow = makeRoot("discover-shadow-");
    const shadowScripts = path.join(shadow, "scripts");
    mkdirSync(shadowScripts, { recursive: true });
    for (const name of readdirSync(path.join(projectRoot, "scripts"))) {
      if (name === "contract-discover.sh") continue;
      symlinkSync(
        path.join(projectRoot, "scripts", name),
        path.join(shadowScripts, name),
      );
    }
    symlinkSync(
      path.join(projectRoot, "node_modules"),
      path.join(shadow, "node_modules"),
    );
    writeFileSync(
      path.join(shadowScripts, "contract-discover.sh"),
      readFileSync(discoverScript, "utf8").split(
        "scripts/contracts/author-cli.mjs workerd-path",
      ).join("scripts/contracts/cli.mjs workerd-path"),
    );

    const result = runDiscover(shadow, ["--print-workerd"]);

    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /unknown command "workerd-path"/);
  });
});
