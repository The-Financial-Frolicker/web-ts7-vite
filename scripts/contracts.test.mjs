/**
 * Tests for the deterministic contract system.
 *
 * Everything here runs on synthetic fixtures: no workerd, no Vite, no installed
 * npm packages (the last describe block reads the real repository read-only).
 * The properties under test are the ones CI depends on — stable fingerprints,
 * complete input coverage, deterministic refresh, read-only verification, and a
 * report that distinguishes a missing contract from a changed one.
 */
import assert from "./lib/assert.mjs";
import { run } from "./lib/command.mjs";
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

import { describeLockChanges } from "./contracts/author-cli.mjs";
import {
  canonicalJson,
  contractKey,
  fingerprintOf,
} from "./contracts/canonical.mjs";
import {
  DEFAULT_VITE_BUILD_TARGET,
  readLibs,
  readViteBuildTarget,
  readWranglerConfig,
  stripJsonc,
} from "./contracts/config.mjs";
import {
  buildLock,
  deriveWorkerLibEdition,
  fingerprintInputs,
  requireEmscripten,
  SCOPE_LAUNCHER_PERMISSIONS,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_VITE_TARGET,
  SCOPE_WORKERD_RUNTIME,
  SCOPES,
} from "./contracts/discover.mjs";
import {
  capabilitiesForEdition,
  EDITIONS,
  probeConfigSource,
  probeWorkerSource,
} from "./contracts/fixtures.mjs";
import { contractInputs } from "./contracts/identity.mjs";
import { describePath } from "./contracts/toolchain.mjs";
import {
  describePermissionProfiles,
  normalisePermissionFlags,
} from "./contracts/permissions.mjs";
import {
  CONTRACT_STATUSES,
  SCHEMA_VERSION,
  unverifiedValues,
  validateDocument,
} from "./contracts/schema.mjs";
import {
  CONTRACT_FILE,
  loadDocument,
  lockDigest,
  summarise,
  writeDocument,
} from "./contracts/store.mjs";
import {
  buildConformanceReport,
  clientEditionProblems,
  declaredEdition,
  denoProblems,
  generatedConfigProblems,
  summariseScope,
  verifyContracts,
} from "./contracts/verify.mjs";
import {
  mapProbeOutcome,
  parseHttpResponse,
} from "./contracts/workerd-probe.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
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

function value(provenance, entry = true) {
  return { kind: "test", value: entry, provenance, evidence: "fixture" };
}

/** A synthetic identity in the shape derivation consumes. */
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
      buildTarget: DEFAULT_VITE_BUILD_TARGET,
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
    ...overrides,
  };
}

/** Minimal valid values per scope. */
function scopeValues(scope) {
  switch (scope) {
    case SCOPE_WORKERD_RUNTIME:
      return {
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
        "typescript.worker.libEdition": value("derived", "es2025"),
      };
    case SCOPE_TYPESCRIPT_LIBRARIES:
      return {
        "typescript.clientLib": value("authoritative", ["ES2023", "DOM"]),
        "typescript.workerLib": value("authoritative", ["ES2025"]),
        "typescript.editions": value("observed", [
          "es2022",
          "es2023",
          "es2025",
        ]),
      };
    case SCOPE_LAUNCHER_PERMISSIONS:
      return { "launcher.vite-build": value("derived", ["--allow-read"]) };
    default:
      return {
        "vite.build.target": value("authoritative", DEFAULT_VITE_BUILD_TARGET),
        "vite.build.targets": value("observed", ["chrome111"]),
      };
  }
}

/** Build a lock from a synthetic identity. */
function lockFor(who = identity(), values = {}) {
  const merged = Object.fromEntries(
    SCOPES.map((scope) => [scope, values[scope] ?? scopeValues(scope)]),
  );
  return buildLock({
    identity: who,
    toolchain: { deno: { version: Deno.version.deno } },
    values: merged,
  });
}

/** Identity with one field replaced, for drift tests. */
function withInput(name, value) {
  const base = identity();
  if (name === "buildTarget") {
    return identity({ vite: { ...base.vite, buildTarget: value } });
  }
  if (name === "clientLib") {
    return identity({ typescript: { ...base.typescript, clientLib: value } });
  }
  if (name === "workerLib") {
    return identity({ typescript: { ...base.typescript, workerLib: value } });
  }
  if (name === "launchers") return identity({ launchers: value });
  if (name === "compatibilityDate") {
    return identity({
      wrangler: { ...base.wrangler, compatibilityDate: value },
    });
  }
  throw new Error(`unknown input ${name}`);
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

  it("reads the declared Vite build target", () => {
    const root = makeRoot();
    write(
      root,
      "vite.config.ts",
      'export default { build: { target: "chrome111" } };\n',
    );
    assert.equal(readViteBuildTarget(root), "chrome111");

    write(
      root,
      "vite.config.ts",
      'export default { build: { target: ["es2022", "chrome111"] } };\n',
    );
    assert.deepEqual(readViteBuildTarget(root), ["es2022", "chrome111"]);
  });

  it("records Vite's symbolic default and fails closed on expressions", () => {
    const root = makeRoot();
    write(
      root,
      "vite.config.ts",
      "// target: 'not-a-declaration'\nexport default { build: {} };\n",
    );
    assert.equal(readViteBuildTarget(root), DEFAULT_VITE_BUILD_TARGET);

    write(
      root,
      "vite.config.ts",
      "export default { build: { target: browserTarget } };\n",
    );
    assert.throws(() => readViteBuildTarget(root), /must be a string literal/);

    write(
      root,
      "vite.config.ts",
      'export default { build: { target: "a" }, other: { target: "b" } };\n',
    );
    assert.throws(() => readViteBuildTarget(root), /more than once/);
  });
});

describe("schema validation", () => {
  it("accepts a well-formed lock", async () => {
    const document = await lockFor();
    validateDocument(document);
    assert.equal(document.schemaVersion, SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 2);
  });

  it("rejects v1 lifecycle metadata and unknown fields", async () => {
    const document = await lockFor();
    const [key] = Object.keys(document.contracts);

    for (const field of ["state", "approved", "bootstrap"]) {
      const copy = structuredClone(document);
      copy.contracts[key][field] = "approved";
      assert.throws(() => validateDocument(copy), /v1 lifecycle metadata/);
    }

    const withPolicies = structuredClone(document);
    withPolicies.policies = {};
    assert.throws(
      () => validateDocument(withPolicies),
      /v1 lifecycle metadata/,
    );

    const extra = structuredClone(document);
    extra.contracts[key].reviewedBy = "someone";
    assert.throws(() => validateDocument(extra), /unknown field/);
  });

  it("rejects an unknown provenance value", async () => {
    const document = await lockFor();
    const contract = Object.values(document.contracts)[0];
    contract.values["x.test"] = value("declared");
    assert.throws(() => validateDocument(document), /expected one of/);
  });

  it("lists unverified values", () => {
    const contract = {
      values: { a: value("observed"), b: value("unverified") },
    };
    assert.deepEqual(unverifiedValues(contract), ["b"]);
  });

  it("rejects a document from a different schema version", async () => {
    const document = await lockFor();
    document.schemaVersion = 1;
    assert.throws(() => validateDocument(document), /contract:refresh/);
  });

  it("exposes exactly the three conformance statuses", () => {
    assert.deepEqual([...CONTRACT_STATUSES], [
      "recorded",
      "drifted",
      "unrecorded",
    ]);
  });
});

describe("fingerprint coverage", () => {
  it("fingerprints every contract-relevant input", () => {
    const mirror = contractInputs(identity());

    assert.deepEqual(
      Object.keys(fingerprintInputs(SCOPE_WORKERD_RUNTIME, mirror)).sort(),
      ["compatibilityDate", "compatibilityFlags", "platform", "workerd"],
    );
    assert.deepEqual(
      Object.keys(fingerprintInputs(SCOPE_VITE_TARGET, mirror)).sort(),
      ["buildTarget", "platform", "vite"],
    );
    assert.deepEqual(
      Object.keys(fingerprintInputs(SCOPE_TYPESCRIPT_LIBRARIES, mirror))
        .sort(),
      ["clientLib", "platform", "typescript", "workerLib"],
    );
    assert.deepEqual(
      Object.keys(fingerprintInputs(SCOPE_LAUNCHER_PERMISSIONS, mirror))
        .sort(),
      ["launchers", "platform"],
    );
  });

  it("changes only the scope a changed input belongs to", async () => {
    const base = await lockFor();

    for (
      const [input, scope] of [
        ["buildTarget", SCOPE_VITE_TARGET],
        ["clientLib", SCOPE_TYPESCRIPT_LIBRARIES],
        ["workerLib", SCOPE_TYPESCRIPT_LIBRARIES],
        ["compatibilityDate", SCOPE_WORKERD_RUNTIME],
        ["launchers", SCOPE_LAUNCHER_PERMISSIONS],
      ]
    ) {
      const changed = withInput(
        input,
        input === "compatibilityDate" ? "2026-11-01" : { changed: true },
      );
      const report = await buildConformanceReport({
        document: base,
        identity: changed,
      });

      const statuses = Object.fromEntries(
        report.scopes.map((entry) => [entry.scope, entry.status]),
      );
      for (const [name, status] of Object.entries(statuses)) {
        assert.equal(
          status,
          name === scope ? "drifted" : "recorded",
          `${input} must affect only ${scope}: ${name} is ${status}`,
        );
      }
    }
  });
});

describe("worker edition derivation", () => {
  function results(defaultOutcome, overrides = {}) {
    const map = {};
    for (const edition of EDITIONS) {
      for (const entry of capabilitiesForEdition(edition)) {
        map[entry.id] = { outcome: overrides[entry.id] ?? defaultOutcome };
      }
    }
    return map;
  }

  it("claims the newest edition when every probe is supported", () => {
    const derived = deriveWorkerLibEdition(results("supported"));

    assert.equal(derived.edition, "es2025");
    assert.equal(derived.provenance, "derived");
  });

  it("stops at the newest fully supported edition", () => {
    const derived = deriveWorkerLibEdition(
      results("supported", { "es2024.object.groupBy": "unsupported" }),
    );

    assert.equal(derived.edition, "es2023");
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

describe("declared permission profiles", () => {
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

  it("produces the same profiles on a different machine", () => {
    const first = describePermissionProfiles(root);
    const second = describePermissionProfiles("/opt/checkout");

    assert.equal(canonicalJson(first), canonicalJson(second));
  });

  it("records every launcher, including the CI and edge profiles", () => {
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
    assert.ok(profiles["wrangler-types"].length > 0);
    assert.ok(profiles["wrangler-dry-run"].length > 0);

    // The edge verifier's requirement is declared before the launcher exists, so
    // the profile cannot arrive unreviewed later. It is scoped to what the
    // verifier actually does: read the authorised criteria, write evidence,
    // speak to Chrome over loopback, and start that one executable.
    assert.deepEqual(profiles["edge-verify"], [
      "--allow-read=<root>/acceptance",
      "--allow-write=<root>/artifacts",
      "--allow-net=127.0.0.1",
      "--allow-run=<chrome>",
    ]);

    // Broad grants the verifier does not need: Chrome's own traffic to the
    // deployed Worker is outside Deno's sandbox, and a child process inherits
    // the environment without a Deno grant.
    for (
      const forbidden of [
        "--allow-env",
        "--allow-sys",
        "--allow-ffi",
        "--allow-all",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-run",
      ]
    ) {
      assert.equal(
        profiles["edge-verify"].includes(forbidden),
        false,
        `edge-verify must not declare ${forbidden}`,
      );
    }
  });

  it("is fingerprinted deterministically and independently of the host", async () => {
    const mirror = contractInputs(
      identity({ launchers: describePermissionProfiles(root) }),
    );
    const other = contractInputs(
      identity({ launchers: describePermissionProfiles("/opt/checkout") }),
    );

    assert.equal(
      await fingerprintOf(
        fingerprintInputs(SCOPE_LAUNCHER_PERMISSIONS, mirror),
      ),
      await fingerprintOf(
        fingerprintInputs(SCOPE_LAUNCHER_PERMISSIONS, other),
      ),
    );
  });
});

describe("refresh", () => {
  it("builds a v2 lock with one contract per scope", async () => {
    const document = await lockFor();
    validateDocument(document);

    assert.equal(document.schemaVersion, 2);
    assert.equal(Object.keys(document.contracts).length, SCOPES.length);
    for (const scope of SCOPES) {
      const contract = Object.values(document.contracts).find((entry) =>
        entry.scope === scope
      );
      assert.equal(
        contractKey(scope, contract.fingerprint) in document.contracts,
        true,
      );
    }
  });

  it("is deterministic for the same authorised configuration", async () => {
    const first = await lockFor();
    const second = await lockFor();

    assert.equal(canonicalJson(first), canonicalJson(second));
    assert.equal(await lockDigest(first), await lockDigest(second));

    // No timestamps, run identifiers or approval metadata: the lock is facts.
    const serialised = canonicalJson(first);
    assert.doesNotMatch(serialised, /"approved"|"bootstrap"|"state"|"at":/);
    assert.doesNotMatch(serialised, new RegExp(os.tmpdir()));
  });

  it("writes canonical bytes that reload identically", async () => {
    const root = makeRoot("refresh-");
    const document = await lockFor();

    const target = writeDocument(root, document);
    const firstBytes = readFileSync(target, "utf8");
    const reloaded = loadDocument(root);

    assert.equal(canonicalJson(reloaded), canonicalJson(document));
    assert.equal(await lockDigest(reloaded), await lockDigest(document));

    writeDocument(root, reloaded);
    assert.equal(readFileSync(target, "utf8"), firstBytes);
  });

  it("reports what it recorded relative to the previous lock", async () => {
    const previous = await lockFor();
    const unchanged = describeLockChanges(previous, await lockFor());

    assert.deepEqual(
      unchanged.map((change) => change.kind),
      SCOPES.map(() => "unchanged"),
    );

    // A value-only change is not a fingerprint change.
    const values = await lockFor(identity(), {
      [SCOPE_WORKERD_RUNTIME]: {
        ...scopeValues(SCOPE_WORKERD_RUNTIME),
        "runtime.capability.es2025.set.union": value("observed", "supported"),
      },
    });
    const valueChanges = describeLockChanges(previous, values);
    const runtime = valueChanges.find((change) =>
      change.scope === SCOPE_WORKERD_RUNTIME
    );
    assert.equal(runtime.kind, "values");
    assert.deepEqual(runtime.valueChanges, [
      "runtime.capability.es2025.set.union",
    ]);

    // A changed input changes the fingerprint of exactly one scope.
    const drifted = await lockFor(withInput("buildTarget", "chrome111"));
    const fingerprintChanges = describeLockChanges(previous, drifted);
    assert.deepEqual(
      fingerprintChanges.filter((change) => change.kind === "fingerprint")
        .map((change) => change.scope),
      [SCOPE_VITE_TARGET],
    );

    // A scope that disappears from a derived lock is reported, not ignored.
    const removed = describeLockChanges(previous, {
      schemaVersion: 2,
      toolchain: {},
      contracts: Object.fromEntries(
        Object.entries(previous.contracts).filter(([, contract]) =>
          contract.scope !== SCOPE_VITE_TARGET
        ),
      ),
    });
    assert.equal(
      removed.find((change) => change.scope === SCOPE_VITE_TARGET).kind,
      "removed",
    );
  });
});

describe("conformance", () => {
  it("passes when the derivation matches the lock", async () => {
    const report = await buildConformanceReport({
      document: await lockFor(),
      identity: identity(),
      digest: "sha256:lock",
    });

    assert.equal(report.verdict, "conformant");
    assert.deepEqual(report.problems, []);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.lockDigest, "sha256:lock");
    assert.equal(report.scopes.length, SCOPES.length);
  });

  it("fails on drift and names the changed inputs", async () => {
    const report = await buildConformanceReport({
      document: await lockFor(),
      identity: withInput("clientLib", ["ES2025", "DOM"]),
    });

    assert.equal(report.verdict, "drifted");
    const entry = report.scopes.find((scope) =>
      scope.scope === SCOPE_TYPESCRIPT_LIBRARIES
    );
    assert.equal(entry.status, "drifted");
    assert.deepEqual(entry.changedInputs.map((change) => change.name), [
      "clientLib",
    ]);
    assert.match(report.problems.join(" "), /has drifted/);
  });

  it("distinguishes an unrecorded scope from a drifted one", async () => {
    const document = await lockFor();
    for (const [key, contract] of Object.entries(document.contracts)) {
      if (contract.scope === SCOPE_VITE_TARGET) delete document.contracts[key];
    }

    const report = await buildConformanceReport({
      document,
      identity: identity(),
    });

    const entry = report.scopes.find((scope) =>
      scope.scope === SCOPE_VITE_TARGET
    );
    assert.equal(entry.status, "unrecorded");
    assert.equal(entry.recordedKey, null);
    assert.equal(entry.recordedFingerprint, null);
    assert.match(report.problems.join(" "), /is unrecorded/);
  });

  it("never rewrites the lock, even when verification fails", async () => {
    const root = makeRoot("conformance-");
    const target = writeDocument(root, await lockFor());
    const before = readFileSync(target, "utf8");

    const report = await buildConformanceReport({
      document: loadDocument(root),
      identity: withInput("compatibilityDate", "2026-11-01"),
    });

    assert.equal(report.verdict, "drifted");
    assert.equal(readFileSync(target, "utf8"), before);
  });
});

describe("verification helpers", () => {
  it("normalises declared editions and picks the highest", () => {
    assert.equal(declaredEdition(["ES2023", "DOM"]), "es2023");
    assert.equal(declaredEdition(["ESNext"]), "esnext");
    assert.equal(declaredEdition(["DOM"]), null);
  });

  it("requires the declared client edition to exist in the compiler", () => {
    assert.deepEqual(clientEditionProblems("es2023", ["es2022", "es2023"]), []);
    assert.match(
      clientEditionProblems("es2030", ["es2023"]).join(" "),
      /does not provide that edition/,
    );
    assert.deepEqual(clientEditionProblems(null, ["es2023"]), []);
    assert.deepEqual(clientEditionProblems("es2023", undefined), []);
  });

  it("summarises a scope for humans", () => {
    const line = summariseScope({
      scope: SCOPE_WORKERD_RUNTIME,
      status: "drifted",
      recordedFingerprint: `sha256:${"a".repeat(64)}`,
      derivedFingerprint: `sha256:${"b".repeat(64)}`,
    });

    assert.match(line, /workerd-runtime drifted/);
    assert.match(line, /recorded=aaaaaaaaaaaa/);
    assert.match(line, /derived=bbbbbbbbbbbb/);
  });

  it("compares the generated configuration with the recorded values", async () => {
    const root = makeRoot("generated-");
    const document = await lockFor();
    const runtime = Object.values(document.contracts).find((contract) =>
      contract.scope === SCOPE_WORKERD_RUNTIME
    );

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

describe("refresh preconditions", () => {
  it("requires the authorised Emscripten SDK", () => {
    const missing = new Map();
    assert.throws(
      () => requireEmscripten(missing),
      /EMSDK is not set/,
    );

    const notADirectory = (target) => ({ isDirectory: false, target });
    assert.throws(
      () =>
        requireEmscripten(new Map([["EMSDK", "/opt/emsdk"]]), notADirectory),
      /not a readable SDK directory/,
    );

    const ok = (target) => ({ isDirectory: true, target });
    assert.equal(
      requireEmscripten(new Map([["EMSDK", "/opt/emsdk"]]), ok),
      "/opt/emsdk",
    );
  });
});

describe("recorded interpreter", () => {
  it("passes when the running Deno is the recorded one", async () => {
    const document = await lockFor();
    assert.deepEqual(denoProblems(document), []);
  });

  it("fails when a different Deno runs, naming both versions", async () => {
    const document = await lockFor();
    const problems = denoProblems(document, "1.0.0");

    assert.equal(problems.length, 1);
    assert.match(problems[0], /records Deno/);
    assert.match(problems[0], /1\.0\.0/);
    assert.match(problems[0], /contract:refresh/);
  });

  it("fails closed when the lock records no Deno version", async () => {
    const document = await lockFor();
    delete document.toolchain.deno;

    assert.match(denoProblems(document).join(" "), /records no Deno version/);
  });

  it("keeps provenance out of every conformance fingerprint", async () => {
    const who = identity();
    const withProvenance = await lockFor();
    const other = await buildLock({
      identity: who,
      toolchain: {
        deno: { version: "0.0.0-other-machine" },
        emscripten: { sdkVersion: { value: "0.0.0", available: false } },
      },
      values: Object.fromEntries(
        SCOPES.map((scope) => [scope, scopeValues(scope)]),
      ),
    });

    // The provenance block is recorded, not fingerprinted: the same authorised
    // environment yields the same contracts on any machine that records them.
    for (const scope of SCOPES) {
      const left = Object.values(withProvenance.contracts).find((contract) =>
        contract.scope === scope
      );
      const right = Object.values(other.contracts).find((contract) =>
        contract.scope === scope
      );
      assert.equal(left.fingerprint, right.fingerprint, scope);
    }

    // …which is precisely why the interpreter needs its own explicit check.
    assert.match(denoProblems(other).join(" "), /records Deno 0\.0\.0-other/);
  });
});

describe("committed lock", () => {
  const lock = JSON.parse(
    readFileSync(path.join(projectRoot, CONTRACT_FILE), "utf8"),
  );

  it("is a v2 lock with no approval metadata", () => {
    validateDocument(lock);
    assert.equal(lock.schemaVersion, 2);
    assert.equal("policies" in lock, false);

    for (const contract of Object.values(lock.contracts)) {
      for (const field of ["state", "approved", "bootstrap"]) {
        assert.equal(field in contract, false, `${field} must be absent`);
      }
    }
  });

  it("records every scope exactly once", () => {
    const scopes = Object.values(lock.contracts).map((contract) =>
      contract.scope
    );
    assert.deepEqual([...scopes].sort(), [...SCOPES].sort());
    assert.equal(new Set(scopes).size, scopes.length);
  });

  it("contains no machine-specific absolute or escaping path", () => {
    const offenders = [];
    (function scan(entry, where) {
      if (typeof entry === "string") {
        if (entry.startsWith("/")) offenders.push(`${where} = ${entry}`);
        if (entry.split("/").includes("..")) {
          offenders.push(`${where} escapes the project root: ${entry}`);
        }
        return;
      }
      if (entry === null || typeof entry !== "object") return;
      for (const [key, child] of Object.entries(entry)) {
        scan(child, `${where}.${key}`);
      }
    })(lock, "lock");

    assert.deepEqual(offenders, [], offenders.join("; "));
  });

  it("describes external artefact locations without leaking a layout", () => {
    const root = "/home/someone/project";

    assert.equal(
      describePath(root, `${root}/node_modules/.deno/vite@1/node_modules/vite`),
      "node_modules/.deno/vite@1/node_modules/vite",
    );
    // A shared store or a symlinked node_modules resolves outside the project.
    assert.equal(
      describePath(
        root,
        "/opt/shared/deno/node_modules/.deno/vite@1/node_modules/vite",
      ),
      "<external>/vite",
    );
    assert.equal(describePath(root, root), ".");
  });

  it("summarises one entry per scope", () => {
    const rows = summarise(lock);
    assert.equal(rows.length, SCOPES.length);
    for (const row of rows) {
      assert.equal(typeof row.fingerprint, "string");
      assert.ok(row.values > 0);
    }
  });
});

describe("refresh entry point wiring", () => {
  const refreshScript = path.join(
    projectRoot,
    "scripts",
    "contract-refresh.sh",
  );
  const hasDependencies = existsSync(path.join(projectRoot, "node_modules"));

  it("targets the generator-only authoring CLI", () => {
    const script = readFileSync(refreshScript, "utf8");

    assert.match(script, /scripts\/contracts\/author-cli\.mjs refresh/);
    assert.match(script, /scripts\/contracts\/author-cli\.mjs workerd-path/);
    assert.doesNotMatch(script, /scripts\/contracts\/cli\.mjs/);

    // Only the generator CLI defines `refresh`; the product CLI must not.
    assert.match(
      readFileSync(
        path.join(projectRoot, "scripts/contracts/author-cli.mjs"),
        "utf8",
      ),
      /command === "refresh"/,
    );
    assert.doesNotMatch(
      readFileSync(path.join(projectRoot, "scripts/contracts/cli.mjs"), "utf8"),
      /command === "refresh"|case "refresh"/,
    );
  });

  it("is the only writer of the lock", () => {
    const script = readFileSync(refreshScript, "utf8");
    assert.match(
      script,
      /--allow-write="\$PROJECT_ROOT\/toolchain-contracts\.json/,
    );

    // Verification keeps the narrow read-only profile: it cannot repair drift.
    const verifyScript = readFileSync(
      path.join(projectRoot, "scripts/check-contracts.sh"),
      "utf8",
    );
    assert.doesNotMatch(verifyScript, /--allow-write/);
  });

  it("resolves the runtime without deriving anything", {
    skip: !hasDependencies,
  }, () => {
    const result = run("/bin/bash", {
      args: [refreshScript, "--print-workerd"],
      cwd: projectRoot,
      env: {
        ...Deno.env.toObject(),
        PATH: `${path.dirname(Deno.execPath())}:${Deno.env.get("PATH") ?? ""}`,
      },
    });

    assert.equal(result.code, 0, result.stderr);
    const printed = result.stdout.trim();
    assert.match(printed, /\/bin\/workerd$/, printed);
    assert.equal(existsSync(printed), true, `${printed} does not exist`);
  });
});

describe("repository conformance", () => {
  it("conforms end to end in this repository", {
    skip: !existsSync(path.join(projectRoot, "node_modules")),
  }, async () => {
    const { report, problems, notes } = await verifyContracts(projectRoot);

    assert.deepEqual(problems, [], problems.join("\n"));
    assert.equal(report.verdict, "conformant");
    assert.equal(report.scopes.length, SCOPES.length);
    for (const entry of report.scopes) {
      assert.equal(entry.status, "recorded", summariseScope(entry));
    }
    assert.match(notes[0], /^lock sha256:/);

    const digest = await lockDigest(loadDocument(projectRoot));
    assert.equal(report.lockDigest, digest);
  });
});
