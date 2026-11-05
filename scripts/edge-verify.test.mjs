/**
 * Tests for deployed-edge acceptance.
 *
 * These exercise the *decision logic* without a Cloudflare deployment or a
 * browser: the assertions, the evidence invariant, and the argument contract.
 * The authoritative workflow is the only place a real deployment is tested.
 */
import assert from "./lib/assert.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";

import {
  buildEdgeVerifyArgs,
  buildEvidence,
  collectDiagnostic,
  evaluateAcceptance,
  main,
  parseBuildIdentity,
  parseVerifyArgs,
  waitForRendered,
} from "./edge-verify.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const criteria = JSON.parse(
  readFileSync(path.join(projectRoot, "acceptance", "criteria.json"), "utf8"),
);

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeArtifacts() {
  const root = mkdtempSync(path.join(os.tmpdir(), "edge-accept-"));
  temporaryRoots.push(root);
  return root;
}

/** What a correctly deployed page renders. */
function healthyPage() {
  return {
    marker: "Get started",
    wasm: "WebAssembly result: 19 + 23 = 42",
    worker: "Worker: ok | cloudflare-workers | 2026-11-05T19:00:00.000Z",
    identity: JSON.stringify({ sha: "abc123", deployment: "edge-123" }),
    documentText: "Get started WebAssembly result: 19 + 23 = 42 " +
      "Worker: ok | cloudflare-workers | 2026-11-05T19:00:00.000Z",
  };
}

function acceptance(observed, expectations = {}) {
  return evaluateAcceptance({
    criteria,
    observed,
    expectations: {
      httpStatus: 200,
      expectedSha: "abc123",
      expectedDeployment: "edge-123",
      ...expectations,
    },
  });
}

function statusOf(assertions, id) {
  return assertions.find((entry) => entry.id === id)?.status;
}

function context(overrides = {}) {
  return {
    suiteVersion: criteria.suiteVersion,
    generatedAt: "2026-11-05T19:00:00.000Z",
    sha: "abc123",
    runId: "1",
    runAttempt: "1",
    workerName: "edge-123",
    expectedSha: "abc123",
    expectedDeployment: "edge-123",
    url: "https://edge-123.example.workers.dev",
    urlSource: "cloudflare-api:workers/subdomain",
    deploymentId: "ver-1",
    deployExitCode: 0,
    httpStatus: 200,
    ...overrides,
  };
}

describe("deployed-edge acceptance criteria", () => {
  it("accepts a correctly deployed application", () => {
    const assertions = acceptance(healthyPage());

    assert.deepEqual(
      assertions.filter((entry) => entry.status === "fail"),
      [],
    );
    const evidence = buildEvidence({ context: context(), assertions });
    assert.equal(evidence.accepted, true);
    assert.equal(evidence.assertions.length, 7);
  });

  it("rejects a missing or incorrect application marker", () => {
    for (const marker of [null, "Get started somewhere else", ""]) {
      const assertions = acceptance({ ...healthyPage(), marker });
      assert.equal(statusOf(assertions, "page.marker"), "fail", `${marker}`);
      assert.equal(
        buildEvidence({ context: context(), assertions }).accepted,
        false,
      );
    }
  });

  it("rejects missing WebAssembly output", () => {
    const assertions = acceptance({
      ...healthyPage(),
      wasm: "Loading WebAssembly...",
      documentText: "Get started Loading WebAssembly...",
    });

    assert.equal(statusOf(assertions, "wasm.output"), "fail");
    assert.equal(statusOf(assertions, "no.failure-markers"), "fail");
    assert.equal(
      buildEvidence({ context: context(), assertions }).accepted,
      false,
    );
  });

  it("rejects an incorrect mathematical result", () => {
    const assertions = acceptance({
      ...healthyPage(),
      wasm: "WebAssembly result: 19 + 23 = 41",
    });

    assert.equal(statusOf(assertions, "wasm.output"), "fail");
    assert.equal(
      buildEvidence({ context: context(), assertions }).accepted,
      false,
    );
  });

  it("rejects a page that did not answer with HTTP 200", () => {
    const assertions = acceptance(healthyPage(), { httpStatus: 404 });
    assert.equal(statusOf(assertions, "http.page"), "fail");
  });

  it("rejects a page built from another revision or deployment", () => {
    for (
      const identity of [
        { sha: "deadbeef", deployment: "edge-123" },
        { sha: "abc123", deployment: "edge-999" },
      ]
    ) {
      const assertions = acceptance({
        ...healthyPage(),
        identity: JSON.stringify(identity),
      });

      assert.equal(
        statusOf(assertions, "build.sha"),
        identity.sha === "abc123" ? "pass" : "fail",
      );
      assert.equal(
        statusOf(assertions, "build.deployment"),
        identity.deployment === "edge-123" ? "pass" : "fail",
      );
      assert.equal(
        buildEvidence({ context: context(), assertions }).accepted,
        false,
      );
    }

    const assertions = acceptance({
      ...healthyPage(),
      identity: "not json",
    });
    assert.equal(statusOf(assertions, "build.sha"), "fail");
    assert.equal(statusOf(assertions, "build.deployment"), "fail");
    assert.equal(
      buildEvidence({ context: context(), assertions }).accepted,
      false,
    );
  });

  it("rejects an unreadable page", () => {
    const assertions = acceptance({ documentText: "" });

    assert.equal(statusOf(assertions, "page.marker"), "fail");
    assert.equal(statusOf(assertions, "wasm.output"), "fail");
    assert.equal(statusOf(assertions, "worker.identity"), "fail");
  });

  it("cannot report acceptance when any required assertion failed", () => {
    const healthy = acceptance(healthyPage());
    for (const failing of healthy) {
      const assertions = healthy.map((entry) =>
        entry.id === failing.id ? { ...entry, status: "fail" } : entry
      );
      assert.equal(
        buildEvidence({ context: context(), assertions }).accepted,
        false,
        `${failing.id} must veto acceptance`,
      );
    }

    // An empty assertion list is not a vacuous pass either.
    assert.equal(
      buildEvidence({ context: context(), assertions: [] }).accepted,
      false,
    );
  });

  it("records the tested instance in the evidence", () => {
    const evidence = buildEvidence({
      context: context(),
      assertions: acceptance(healthyPage()),
      observed: healthyPage(),
      browser: { product: "HeadlessChrome/131.0.0.0" },
    });

    assert.equal(evidence.source.sha, "abc123");
    assert.equal(evidence.deployment.workerName, "edge-123");
    assert.equal(
      evidence.deployment.url,
      "https://edge-123.example.workers.dev",
    );
    assert.equal(
      evidence.deployment.urlSource,
      "cloudflare-api:workers/subdomain",
    );
    assert.equal(evidence.deployment.deploymentId, "ver-1");
    assert.equal(evidence.http.status, 200);
    assert.equal(evidence.suiteVersion, criteria.suiteVersion);
    assert.equal(evidence.generatedAt, "2026-11-05T19:00:00.000Z");
    assert.deepEqual(evidence.identity.expected, {
      sha: "abc123",
      deployment: "edge-123",
    });
    assert.deepEqual(evidence.identity.observed, {
      sha: "abc123",
      deployment: "edge-123",
    });
  });
});

describe("edge verifier invocation", () => {
  it("requires the deployment facts and rejects unknown arguments", () => {
    const base = [
      "--expected-sha",
      "abc",
      "--expected-deployment",
      "edge-1",
      "--url",
      "https://x.workers.dev",
      "--worker",
      "edge-1",
      "--sha",
      "abc",
      "--criteria",
      "acceptance/criteria.json",
      "--out",
      "artifacts",
      "--chrome",
      "/usr/bin/google-chrome",
    ];

    assert.equal(parseVerifyArgs(base).workerName, "edge-1");
    assert.throws(() => parseVerifyArgs(["--url"]), /requires a value/);
    assert.throws(() => parseVerifyArgs(["--nope", "x"]), /unknown argument/);
    assert.throws(
      () => parseVerifyArgs(base.slice(0, -2)),
      /missing required argument/,
    );
  });

  it("runs under exactly the declared permission profile", () => {
    const declared = buildEdgeVerifyArgs({
      script: "scripts/edge-verify.mjs",
      chrome: "$CHROME",
      criteriaDir: "$PROJECT_ROOT/acceptance",
      artifactsDir: "$ARTIFACTS",
    });

    const script = readFileSync(
      path.join(projectRoot, "scripts", "edge-accept.sh"),
      "utf8",
    );
    const block = script.slice(script.indexOf("deno run"));
    // Normalise quoting so the assertion is about flags, not shell style.
    const invocation = block
      .slice(0, block.indexOf("scripts/edge-verify.mjs"))
      .replaceAll('"', "");

    for (
      const flag of declared.filter((entry) => entry.startsWith("--allow-"))
    ) {
      assert.ok(
        invocation.includes(flag.replaceAll('"', "")),
        `wrapper is missing ${flag}`,
      );
    }
    assert.ok(invocation.includes("--cached-only"));
    assert.ok(invocation.includes("--frozen"));
    assert.equal(
      invocation.includes("--allow-all"),
      false,
      "the verifier must not run with all permissions",
    );
  });

  it("writes a rejected result when the browser cannot start", async () => {
    const out = makeArtifacts();
    const lines = [];
    const io = {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    };

    const code = await main(
      [
        "--url",
        "https://unreachable.invalid",
        "--worker",
        "edge-123",
        "--sha",
        "abc123",
        "--criteria",
        path.join(projectRoot, "acceptance", "criteria.json"),
        "--out",
        out,
        "--chrome",
        path.join(out, "no-such-chrome"),
        "--http-status",
        "000",
        "--expected-sha",
        "abc123",
        "--expected-deployment",
        "edge-123",
      ],
      io,
      () => "2026-11-05T19:00:00.000Z",
    );

    assert.equal(code, 1, lines.join("\n"));
    const evidence = JSON.parse(
      readFileSync(path.join(out, "acceptance.json"), "utf8"),
    );
    assert.equal(evidence.accepted, false);
    assert.equal(evidence.assertions[0].id, "browser.navigation");
    assert.equal(evidence.assertions[0].status, "fail");
    assert.equal(existsSync(path.join(out, "acceptance.json")), true);
  });
});

describe("diagnostics and settle behaviour", () => {
  it("parses the page build identity and refuses anything else", () => {
    assert.deepEqual(
      parseBuildIdentity(JSON.stringify({ sha: "a", deployment: "b" })),
      { sha: "a", deployment: "b" },
    );
    assert.equal(parseBuildIdentity(null), null);
    assert.equal(parseBuildIdentity(""), null);
    assert.equal(parseBuildIdentity("not json"), null);
    assert.equal(parseBuildIdentity(JSON.stringify({ sha: "a" })), null);
  });

  it("records diagnostics that explain a rejection", () => {
    const diagnostics = {
      exceptions: [],
      consoleErrors: [],
      wasmResponses: [],
    };

    collectDiagnostic(diagnostics, "Runtime.exceptionThrown", {
      exceptionDetails: { text: "boom" },
    });
    collectDiagnostic(diagnostics, "Runtime.consoleAPICalled", {
      type: "error",
      args: [{ value: "wasm failed" }],
    });
    collectDiagnostic(diagnostics, "Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "hello" }],
    });
    collectDiagnostic(diagnostics, "Network.responseReceived", {
      response: { url: "https://x/wasm/wasm_math.wasm", status: 200 },
    });
    collectDiagnostic(diagnostics, "Network.responseReceived", {
      response: { url: "https://x/assets/app.js", status: 200 },
    });

    assert.deepEqual(diagnostics.exceptions, ["boom"]);
    assert.deepEqual(diagnostics.consoleErrors, ["wasm failed"]);
    assert.deepEqual(diagnostics.wasmResponses, [
      { url: "https://x/wasm/wasm_math.wasm", status: 200 },
    ]);
  });

  it("settles once the WebAssembly result is no longer loading", async () => {
    const scripted = [
      "Loading WebAssembly...",
      "WebAssembly result: 19 + 23 = 42",
    ];
    let index = 0;
    const cdp = {
      send: () =>
        Promise.resolve({
          result: {
            value: JSON.stringify({
              marker: "Get started",
              wasm: scripted[Math.min(index++, scripted.length - 1)],
              worker: "Worker: ok | cloudflare-workers",
              identity: null,
              documentText: "",
            }),
          },
        }),
    };

    const observed = await waitForRendered(cdp, "session", criteria, 5_000);
    assert.equal(observed.wasm, "WebAssembly result: 19 + 23 = 42");
  });

  it("returns the last observation when the settle budget expires", async () => {
    const cdp = {
      send: () =>
        Promise.resolve({
          result: {
            value: JSON.stringify({
              marker: "Get started",
              wasm: "Loading WebAssembly...",
              worker: null,
              identity: null,
              documentText: "",
            }),
          },
        }),
    };

    const observed = await waitForRendered(cdp, "session", criteria, 50);
    assert.equal(observed.wasm, "Loading WebAssembly...");
  });
});
