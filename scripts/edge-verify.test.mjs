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
  createNavigationTracker,
  evaluateAcceptance,
  main,
  navigationVerdict,
  observeNavigation,
  parseBuildIdentity,
  parseVerifyArgs,
  readinessProblems,
  sha256OfBytes,
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
      edgeReady: true,
      httpStatus: 200,
      navigationStatus: 200,
      expectedSha: "abc123",
      expectedDeployment: "edge-123",
      ...expectations,
    },
  });
}

/** A cdp stand-in that replays scripted observations, one per read. */
function scriptedCdp(observations) {
  const state = { reads: 0 };
  return {
    state,
    send: () => {
      const index = Math.min(state.reads, observations.length - 1);
      state.reads += 1;
      return Promise.resolve({
        result: { value: JSON.stringify(observations[index]) },
      });
    },
  };
}

/** A deterministic clock: `sleep` advances time instead of waiting for it. */
function fakeClock() {
  const state = { now: 0 };
  return {
    state,
    now: () => state.now,
    sleep: (ms) => {
      state.now += ms;
      return Promise.resolve();
    },
  };
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
    assert.equal(evidence.assertions.length, 9);
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

  it("cannot accept a navigation the browser received as 404", () => {
    const assertions = acceptance(healthyPage(), { navigationStatus: 404 });
    assert.equal(statusOf(assertions, "browser.navigation"), "fail");
    assert.equal(
      buildEvidence({ context: context(), assertions }).accepted,
      false,
    );
  });

  it("cannot accept a navigation whose status was never observed", () => {
    // Not observed is not "probably fine": the page was not shown to load.
    const assertions = acceptance(healthyPage(), { navigationStatus: null });
    assert.equal(statusOf(assertions, "browser.navigation"), "fail");
    assert.equal(
      buildEvidence({ context: context(), assertions }).accepted,
      false,
    );
  });

  it("cannot accept a deployment that never became ready", () => {
    const assertions = acceptance(healthyPage(), { edgeReady: false });
    assert.equal(statusOf(assertions, "edge.readiness"), "fail");
    assert.equal(
      buildEvidence({ context: context(), assertions }).accepted,
      false,
    );

    const unknown = acceptance(healthyPage(), { edgeReady: null });
    assert.equal(statusOf(unknown, "edge.readiness"), "fail");
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
    assert.equal(
      parseVerifyArgs([...base, "--edge-ready", "true"]).edgeReady,
      "true",
    );
    assert.equal(
      parseVerifyArgs([...base, "--edge-ready", "false"]).edgeReady,
      "false",
    );
    assert.throws(
      () => parseVerifyArgs([...base, "--edge-ready", "yes"]),
      /--edge-ready must be "true" or "false"/,
    );
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

    const clock = fakeClock();
    const settled = await waitForRendered(
      cdp,
      "session",
      criteria,
      5_000,
      clock,
    );
    assert.equal(settled.observed.wasm, "WebAssembly result: 19 + 23 = 42");
    assert.equal(settled.ready, false, "the identity meta is still missing");
  });

  it("returns the last observation when the settle budget expires", async () => {
    const cdp = scriptedCdp([{
      marker: "Get started",
      wasm: "Loading WebAssembly...",
      worker: null,
      identity: null,
      documentText: "",
    }]);

    const clock = fakeClock();
    const settled = await waitForRendered(cdp, "session", criteria, 50, {
      ...clock,
      intervalMs: 25,
    });

    assert.equal(settled.observed.wasm, "Loading WebAssembly...");
    assert.equal(settled.ready, false);
    assert.equal(settled.timedOut, true);
    assert.equal(settled.attempts, 3);
    assert.equal(settled.elapsedMs, 50);
  });
});

describe("browser readiness", () => {
  it("does not count an absent application marker as ready", async () => {
    const page = { ...healthyPage(), marker: null, documentText: "" };

    const problems = readinessProblems(page, criteria);
    assert.match(problems.join("\n"), /#app h1/);

    const clock = fakeClock();
    const settled = await waitForRendered(
      scriptedCdp([page, { ...page, marker: "Get started" }]),
      "session",
      criteria,
      500,
      { ...clock, intervalMs: 100 },
    );

    assert.equal(settled.attempts, 2);
    assert.equal(settled.ready, true, "the marker appears on the second read");
    assert.equal(settled.timedOut, false);
  });

  it("does not count an absent #wasm-result as ready", async () => {
    // This is the defect: the old loop compared the text with the placeholder,
    // so a missing element (null) satisfied "no longer loading" instantly.
    const absent = { ...healthyPage(), wasm: null };
    const problems = readinessProblems(absent, criteria);
    assert.match(problems.join("\n"), /#wasm-result/);

    const clock = fakeClock();
    const settled = await waitForRendered(
      scriptedCdp([absent]),
      "session",
      criteria,
      300,
      { ...clock, intervalMs: 100 },
    );

    assert.equal(settled.ready, false);
    assert.equal(settled.timedOut, true);
    assert.equal(settled.observed.wasm, null);
    assert.ok(settled.attempts > 1, "absence must keep the wait going");
  });

  it("does not count the loading placeholder as ready", async () => {
    const loading = {
      ...healthyPage(),
      wasm: "Loading WebAssembly...",
      worker: "Checking Cloudflare Worker...",
      documentText: "Get started Loading WebAssembly...",
    };

    const problems = readinessProblems(loading, criteria);
    assert.match(problems.join("\n"), /still the placeholder/);

    const clock = fakeClock();
    const settled = await waitForRendered(
      scriptedCdp([loading, healthyPage()]),
      "session",
      criteria,
      2_000,
      { ...clock, intervalMs: 100 },
    );

    assert.equal(settled.ready, true);
    assert.equal(settled.attempts, 2);
    assert.equal(settled.timedOut, false);
    assert.deepEqual(settled.problems, []);
    assert.equal(settled.observed.wasm, "WebAssembly result: 19 + 23 = 42");
  });

  it("counts a rendered marker with completed output as ready immediately", async () => {
    const clock = fakeClock();
    const settled = await waitForRendered(
      scriptedCdp([healthyPage()]),
      "session",
      criteria,
      5_000,
      clock,
    );

    assert.equal(settled.ready, true);
    assert.equal(settled.timedOut, false);
    assert.equal(settled.attempts, 1);
    assert.equal(settled.elapsedMs, 0);
    assert.deepEqual(settled.problems, []);
    assert.deepEqual(
      acceptance(settled.observed).filter((entry) => entry.status === "fail"),
      [],
      "a ready page must satisfy every existing assertion",
    );
  });

  it("requires the worker identity and the build identity as well", () => {
    const noWorker = readinessProblems(
      { ...healthyPage(), worker: null },
      criteria,
    );
    assert.match(noWorker.join("\n"), /#worker-health/);

    const checking = readinessProblems(
      { ...healthyPage(), worker: "Checking Cloudflare Worker..." },
      criteria,
    );
    assert.match(checking.join("\n"), /still the placeholder/);

    const noIdentity = readinessProblems(
      { ...healthyPage(), identity: null },
      criteria,
    );
    assert.match(noIdentity.join("\n"), /build-identity/);
  });
});

describe("browser navigation response", () => {
  it("records the navigation's document response and ignores subresources", () => {
    const tracker = createNavigationTracker();

    tracker.record("Network.responseReceived", {
      type: "Script",
      loaderId: "L1",
      response: { url: "https://x/assets/app.js", status: 200 },
    });
    tracker.record("Network.responseReceived", {
      type: "Document",
      loaderId: "L1",
      response: { url: "https://x/", status: 404, mimeType: "text/html" },
    });

    assert.deepEqual(tracker.get("L1"), {
      url: "https://x/",
      status: 404,
      mimeType: "text/html",
    });
    assert.equal(tracker.get("missing"), null);
    assert.equal(tracker.get(null), null);
    assert.equal(tracker.size, 1);
  });

  it("treats a 404 document response as a failed navigation", () => {
    const response = { url: "https://x/", status: 404, mimeType: "text/html" };
    const verdict = navigationVerdict({ response });

    assert.equal(verdict.status, 404);
    assert.match(verdict.problem, /HTTP 404/);
    assert.deepEqual(navigationVerdict({ response: { status: 200 } }), {
      status: 200,
      problem: null,
    });
  });

  it("does not treat an unobserved or failed navigation as a success", () => {
    const unobserved = navigationVerdict({});
    assert.equal(unobserved.status, null);
    assert.match(unobserved.problem, /not observed/);

    const failed = navigationVerdict({
      errorText: "net::ERR_NAME_NOT_RESOLVED",
    });
    assert.equal(failed.status, null);
    assert.match(failed.problem, /ERR_NAME_NOT_RESOLVED/);
  });

  it("waits for the document response instead of assuming it", async () => {
    const tracker = createNavigationTracker();
    const clock = fakeClock();

    const result = await observeNavigation({
      tracker,
      navigation: { loaderId: "L1" },
      timeoutMs: 1_000,
      intervalMs: 100,
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        if (clock.state.now === 100) {
          tracker.record("Network.responseReceived", {
            type: "Document",
            loaderId: "L1",
            response: { url: "https://x/", status: 200, mimeType: "text/html" },
          });
        }
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.problem, null);
    assert.equal(result.url, "https://x/");
    assert.equal(result.documents, 1);
  });

  it("gives up on an unobserved document response inside the bound", async () => {
    const tracker = createNavigationTracker();
    const clock = fakeClock();

    const result = await observeNavigation({
      tracker,
      navigation: { loaderId: "L1" },
      timeoutMs: 300,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    });

    assert.equal(result.status, null);
    assert.match(result.problem, /not observed/);
    assert.equal(clock.state.now, 300, "the wait is bounded, not unbounded");
  });
});

describe("acceptance criteria digest", () => {
  const encoder = new TextEncoder();

  it("is stable for unchanged bytes", async () => {
    const bytes = encoder.encode('{"wasmResult":{"equals":"42"}}\n');
    const first = await sha256OfBytes(bytes);
    const second = await sha256OfBytes(bytes);

    assert.equal(first, second, "the digest must be deterministic");
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
  });

  it("changes when a criterion changes", async () => {
    const before = await sha256OfBytes(
      encoder.encode('{"wasmResult":{"equals":"42"}}'),
    );
    const after = await sha256OfBytes(
      encoder.encode('{"wasmResult":{"contains":"42"}}'),
    );

    assert.ok(before !== after, "a softened criterion must change the digest");
  });

  it("is recorded in the generated evidence", async () => {
    const digest = await sha256OfBytes(encoder.encode("criteria"));
    const evidence = buildEvidence({
      context: {
        suiteVersion: "edge-acceptance/1",
        criteriaDigest: digest,
        generatedAt: "2026-01-01T00:00:00.000Z",
        sha: "0".repeat(40),
        workerName: "edge-1-1",
        url: "https://example.test",
      },
      assertions: [{ id: "page.marker", status: "pass" }],
    });

    assert.equal(evidence.criteriaDigest, digest);
  });
});
