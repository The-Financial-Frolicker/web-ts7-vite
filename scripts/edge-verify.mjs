/**
 * Declared permission profile for the edge-verification launcher.
 *
 * This file declares a requirement; it does not implement the launcher. The
 * edge-acceptance phase will add the run, and it must then use exactly this
 * profile. Declaring it now keeps the permission contract complete in Phase 1:
 * a launcher whose profile is not recorded cannot be reviewed for least
 * privilege, and a change to these flags becomes contract drift rather than an
 * unnoticed edit.
 *
 * Four different things are easy to conflate here, and only two of them are Deno
 * permissions this launcher needs:
 *
 *   1. Launching and controlling Chrome — `--allow-run=<chrome>`, scoped to the
 *      exact executable. Chrome's own child processes (zygote, renderers) are
 *      not gated by Deno, and no permission is needed for that.
 *   2. The local DevTools connection — `--allow-net=127.0.0.1`. Chrome is
 *      launched with `--remote-debugging-address=127.0.0.1`, and the verifier
 *      must address the endpoint as `127.0.0.1` (not `localhost`) so this
 *      loopback grant covers both the HTTP discovery call and the WebSocket.
 *   3. Chrome's own network access to the deployed Worker — *not* a Deno
 *      permission at all. The browser does that traffic, outside Deno's sandbox,
 *      which is also why Deno needs no broad `--allow-net`.
 *   4. Verifier I/O — read the authorised acceptance criteria, write the run's
 *      evidence. Both are scoped to their directories.
 *
 * Deliberately absent: `--allow-env` (the worker URL, Chrome path and artefact
 * directory arrive as arguments, and a child process inherits the environment
 * without a Deno grant), `--allow-sys` (nothing reads system information), FFI,
 * broad read, broad net and `--allow-all`. Chrome's profile directory lives
 * under the artefact directory, so no temporary-directory write grant is needed.
 */

/** Directory holding the authorised acceptance criteria (read-only input). */
export const EDGE_CRITERIA_DIR = "acceptance";

export function buildEdgeVerifyArgs(invocation, extraArgs = []) {
  return [
    "run",
    `--allow-read=${invocation.criteriaDir}`,
    `--allow-write=${invocation.artifactsDir}`,
    "--allow-net=127.0.0.1",
    `--allow-run=${invocation.chrome}`,
    "--cached-only",
    "--frozen",
    invocation.script,
    ...extraArgs,
  ];
}

/* ------------------------------------------------------------------------- *
 * Acceptance logic (pure)
 *
 * Everything below `evaluateAcceptance` is deliberately free of Chrome, the
 * network and the clock: the assertions that decide acceptance are a pure
 * function of what was observed, so they can be exercised without a deployment.
 * ------------------------------------------------------------------------- */

/**
 * Parse the page's `<meta name="build-identity">` payload.
 *
 * Returns `null` when the value is absent or not the expected shape: an
 * unparsable identity must never be treated as a match.
 */
export function parseBuildIdentity(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;

  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.sha !== "string" || typeof parsed?.deployment !== "string"
    ) {
      return null;
    }
    return { sha: parsed.sha, deployment: parsed.deployment };
  } catch {
    return null;
  }
}

/**
 * Decide whether the page is ready to be evaluated.
 *
 * Absence is *not* readiness: a selector that is not in the document yet (the
 * document has not committed, or the module has not run) is a reason to keep
 * waiting, not a completed observation. The original loop compared the
 * WebAssembly text with the loading placeholder, so a *missing* `#wasm-result`
 * (which reads as `null`) ended the wait immediately — the run reported empty
 * values against a page that rendered moments later (run 42109653598).
 *
 * A terminal failure ("WebAssembly initialisation failed.") is deliberately
 * *not* treated as "keep waiting": it is present, non-empty and not a loading
 * placeholder, so the assertions reject it at once instead of waiting out the
 * budget. Only the selectors and the placeholders in the criteria decide
 * readiness; nothing here decides acceptance.
 */
export function readinessProblems(observed, criteria) {
  const problems = [];
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const placeholders = criteria.loadingPlaceholders ?? [];

  if (text(observed.marker) === "") {
    problems.push(`${criteria.pageMarker.selector} is not rendered yet`);
  }

  const wasm = text(observed.wasm);
  if (wasm === "") {
    problems.push(`${criteria.wasmResult.selector} is not present yet`);
  } else if (placeholders.includes(wasm)) {
    problems.push(
      `WebAssembly result is still the placeholder ${JSON.stringify(wasm)}`,
    );
  }

  const worker = text(observed.worker);
  if (worker === "") {
    problems.push(`${criteria.workerHealth.selector} is not present yet`);
  } else if (placeholders.includes(worker)) {
    problems.push(
      `Worker health is still the placeholder ${JSON.stringify(worker)}`,
    );
  }

  if (text(observed.identity) === "") {
    problems.push("the build-identity meta element is not present yet");
  }

  return problems;
}

/** Selector texts read from the rendered page. */
const OBSERVED_FIELDS = Object.freeze(["marker", "wasm", "worker", "identity"]);

/**
 * Evaluate the authorised criteria against one observation.
 *
 * Returns one entry per assertion with `status: "pass" | "fail"`. A missing
 * value is a failure, never an absence of evidence: an empty page must not
 * produce an empty assertion list that vacuously passes.
 *
 * Two of the entries are about whether the thing under test was reachable at
 * all, not about the application's behaviour: `edge.readiness` (the published URL
 * served the deployed application inside its budget) and `browser.navigation`
 * (the browser received the document with HTTP 200). They are assertions rather
 * than preconditions precisely so a timeout or a 404 is recorded as a rejection
 * with its own evidence instead of ending the run early.
 */
export function evaluateAcceptance({ criteria, observed, expectations = {} }) {
  const assertions = [];
  const text = typeof observed.documentText === "string"
    ? observed.documentText
    : "";

  assertions.push({
    id: "edge.readiness",
    description:
      "the published URL served the deployed application inside the readiness budget",
    expected: true,
    observed: expectations.edgeReady ?? null,
    status: expectations.edgeReady === true ? "pass" : "fail",
  });

  assertions.push({
    id: "http.page",
    description: "the deployed page answers with HTTP 200",
    expected: 200,
    observed: expectations.httpStatus ?? null,
    status: expectations.httpStatus === 200 ? "pass" : "fail",
  });

  assertions.push({
    id: "browser.navigation",
    description:
      "the browser's document request for the deployed URL answered 200",
    expected: 200,
    observed: expectations.navigationStatus ?? null,
    status: expectations.navigationStatus === 200 ? "pass" : "fail",
  });

  assertions.push({
    id: "page.marker",
    description: "the expected application marker is rendered",
    expected: criteria.pageMarker.equals,
    observed: observed.marker ?? null,
    status: observed.marker === criteria.pageMarker.equals ? "pass" : "fail",
  });

  assertions.push({
    id: "wasm.output",
    description:
      "the WebAssembly calculation produced the expected rendered output",
    expected: criteria.wasmResult.equals,
    observed: observed.wasm ?? null,
    status: observed.wasm === criteria.wasmResult.equals ? "pass" : "fail",
  });

  const required = [...criteria.workerHealth.contains];
  const workerText = observed.worker ?? "";
  const missing = required.filter((token) => !workerText.includes(token));
  assertions.push({
    id: "worker.identity",
    description: "the deployed Worker answered the page's health request",
    expected: required,
    observed: workerText,
    status: missing.length === 0 ? "pass" : "fail",
  });

  // Revision identity, read from the page's own `<meta name="build-identity">`.
  // This is what ties the observed page to the *source revision* that was
  // deployed: the project name says nothing about which commit produced it.
  const identity = parseBuildIdentity(observed.identity);
  const expectedSha = expectations.expectedSha ?? null;
  const expectedDeployment = expectations.expectedDeployment ?? null;

  assertions.push({
    id: "build.sha",
    description: "the page was built from the expected source revision",
    expected: expectedSha,
    observed: identity?.sha ?? observed.identity ?? null,
    status: expectedSha !== null && identity?.sha === expectedSha
      ? "pass"
      : "fail",
  });

  assertions.push({
    id: "build.deployment",
    description: "the page belongs to the expected deployment instance",
    expected: expectedDeployment,
    observed: identity?.deployment ?? observed.identity ?? null,
    status: expectedDeployment !== null &&
        identity?.deployment === expectedDeployment
      ? "pass"
      : "fail",
  });

  const failures = criteria.failureMarkers.filter((marker) =>
    text.includes(marker)
  );
  assertions.push({
    id: "no.failure-markers",
    description: "no application-loading or WebAssembly failure text is shown",
    expected: [],
    observed: failures,
    status: failures.length === 0 ? "pass" : "fail",
  });

  for (const field of OBSERVED_FIELDS) {
    if (observed[field] === undefined) {
      assertions.push({
        id: `${field}.observed`,
        description: `${field} could not be read from the page`,
        expected: "a rendered value",
        observed: null,
        status: "fail",
      });
    }
  }

  return assertions;
}

/**
 * Build the machine-readable acceptance result.
 *
 * `accepted` is the conjunction of the assertions and nothing else: a failed
 * assertion cannot be overridden by a successful deployment, a build, or a
 * screenshot.
 */
export function buildEvidence({
  context,
  assertions,
  observed = {},
  browser = {},
}) {
  return {
    schemaVersion: 1,
    suite: "edge-acceptance",
    suiteVersion: context.suiteVersion,
    generatedAt: context.generatedAt,
    source: {
      sha: context.sha,
      runId: context.runId,
      runAttempt: context.runAttempt,
    },
    deployment: {
      workerName: context.workerName,
      url: context.url,
      urlSource: context.urlSource,
      deploymentId: context.deploymentId ?? null,
      deployExitCode: context.deployExitCode ?? null,
    },
    http: { status: context.httpStatus ?? null },
    identity: {
      expected: {
        sha: context.expectedSha ?? null,
        deployment: context.expectedDeployment ?? null,
      },
      observed: parseBuildIdentity(observed.identity),
      raw: observed.identity ?? null,
    },
    browser,
    observed,
    assertions,
    accepted: assertions.length > 0 &&
      assertions.every((assertion) => assertion.status === "pass"),
  };
}

/* ------------------------------------------------------------------------- *
 * Browser: one headless Chrome over the loopback DevTools protocol
 *
 * The lightest reliable option on a GitHub-hosted runner: the preinstalled
 * Chrome, no package, no container, no lockfile change. Strictly scoped to the
 * declared profile above.
 * ------------------------------------------------------------------------- */

/**
 * Record diagnostics that explain a rejection.
 *
 * They are evidence, never verdicts: an application that renders correct output
 * while logging a warning is still accepted, and one that renders nothing is
 * rejected by the assertions regardless of what it logged.
 */
export function collectDiagnostic(diagnostics, method, params = {}) {
  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails ?? {};
    diagnostics.exceptions.push(
      details.text ?? details.exception?.description ?? "uncaught exception",
    );
    return;
  }

  if (method === "Runtime.consoleAPICalled" && params.type === "error") {
    const text = (params.args ?? [])
      .map((argument) => argument.value ?? argument.description ?? "")
      .join(" ")
      .trim();
    if (text !== "") diagnostics.consoleErrors.push(text);
    return;
  }

  if (method === "Network.responseReceived") {
    const url = params.response?.url ?? "";
    if (/\/wasm\/[^/]*\.wasm(\?|$)/.test(url)) {
      diagnostics.wasmResponses.push({ url, status: params.response.status });
    }
  }
}

/** Start Chrome and resolve the DevTools endpoint it prints. */
function startChrome(chrome, profileDir) {
  const child = new Deno.Command(chrome, {
    args: [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "about:blank",
    ],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();

  const endpoint = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stderr) {
      buffer += decoder.decode(chunk);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match !== null) return match[1];
    }
    throw new Error("Chrome exited before reporting a DevTools endpoint");
  })();

  return { child, endpoint };
}

/** One CDP connection; commands are matched to responses by id. */
class Cdp {
  static async connect(endpoint) {
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () =>
        reject(
          new Error(`cannot connect to the DevTools endpoint ${endpoint}`),
        );
    });
    return new Cdp(socket);
  }

  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  /** Subscribe to protocol events (messages without an id). */
  onEvent(listener) {
    this.#listeners.add(listener);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) {
        for (const listener of this.#listeners) {
          listener(message.method, message.params ?? {});
        }
        return;
      }
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(`${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      // Already closed.
    }
  }
}

/** Read the three criterion texts from the rendered page. */
async function readTexts(cdp, sessionId, criteria) {
  const selector = (value) => JSON.stringify(value);
  const expression = `JSON.stringify({
    marker: (document.querySelector(${selector(criteria.pageMarker.selector)})
      || {}).textContent || null,
    wasm: (document.querySelector(${selector(criteria.wasmResult.selector)})
      || {}).textContent || null,
    worker: (document.querySelector(${selector(criteria.workerHealth.selector)})
      || {}).textContent || null,
    identity: (document.querySelector('meta[name="build-identity"]')
      || {}).content || null,
    documentText: document.body ? document.body.innerText : ""
  })`;

  const { result } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  }, sessionId);

  try {
    return JSON.parse(result.value);
  } catch {
    throw new Error("the rendered page could not be read");
  }
}

/**
 * Wait until the page is ready to be evaluated, or the budget expires.
 *
 * The defect this replaces tested only `wasm === "Loading WebAssembly..."`:
 * an *absent* `#wasm-result` produced `null`, which is not the placeholder, so
 * the loop ended immediately and "the page settled" was satisfied by a document
 * that had not rendered anything at all. Absence is now a reason to keep
 * waiting, and only a page with every required value present and no loading
 * placeholder left counts as settled.
 *
 * A timeout is not an exception: the caller records it as evidence and the
 * assertions still decide. Returning the problems is what makes the difference
 * between "ready" and "never rendered" inspectable instead of inferred.
 */
export async function waitForRendered(
  cdp,
  sessionId,
  criteria,
  timeoutMs,
  {
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    intervalMs = 250,
  } = {},
) {
  const startedAt = now();
  let attempts = 0;

  const read = async () => {
    attempts += 1;
    const observed = await readTexts(cdp, sessionId, criteria);
    return { observed, problems: readinessProblems(observed, criteria) };
  };

  let { observed, problems } = await read();

  // An absent element keeps the loop going instead of ending it.
  while (problems.length > 0 && now() - startedAt < timeoutMs) {
    await sleep(intervalMs);
    ({ observed, problems } = await read());
  }

  const elapsedMs = now() - startedAt;
  const ready = problems.length === 0;

  return {
    observed,
    ready,
    problems,
    timedOut: !ready && elapsedMs >= timeoutMs,
    elapsedMs,
    attempts,
    intervalMs,
    timeoutMs,
  };
}

/* ------------------------------------------------------------------------- *
 * Navigation response
 *
 * `Page.navigate` resolves for any document the browser managed to load — a 404
 * included. "The drive did not throw" is therefore not evidence that the page
 * loaded, so the document response is recorded from the protocol and asserted.
 * ------------------------------------------------------------------------- */

/** Bounded wait for the navigation's own document response. */
const NAVIGATION_TIMEOUT_MS = 10_000;

/** A page that was never observed: absence, never a set of empty matches. */
export function emptyObservation() {
  return { documentText: "" };
}

/** Collect document responses, keyed by the loader that requested them. */
export function createNavigationTracker() {
  const documents = new Map();

  return {
    record(method, params) {
      if (method !== "Network.responseReceived") return;
      if (params?.type !== "Document") return;
      if (typeof params.loaderId !== "string") return;

      const response = params.response ?? {};
      documents.set(params.loaderId, {
        url: response.url ?? null,
        status: typeof response.status === "number" ? response.status : null,
        mimeType: response.mimeType ?? null,
      });
    },
    get(loaderId) {
      if (typeof loaderId !== "string") return null;
      return documents.get(loaderId) ?? null;
    },
    get size() {
      return documents.size;
    },
  };
}

/**
 * The verdict for one navigation.
 *
 * `status: null` means the document response was not observed, and not observed
 * is a failure: a page whose response could not be inspected was not shown to
 * have loaded.
 */
export function navigationVerdict({ errorText = null, response = null } = {}) {
  if (typeof errorText === "string" && errorText !== "") {
    return { status: null, problem: `navigation failed: ${errorText}` };
  }

  if (response === null) {
    return {
      status: null,
      problem: "the document response status was not observed",
    };
  }

  const status = typeof response.status === "number" ? response.status : null;
  if (status !== 200) {
    return {
      status,
      problem: `the document response was HTTP ${status ?? "unknown"}`,
    };
  }

  return { status: 200, problem: null };
}

/** Wait for the navigation's document response, then return its verdict. */
export async function observeNavigation({
  tracker,
  navigation,
  timeoutMs = NAVIGATION_TIMEOUT_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = 50,
}) {
  const loaderId = navigation?.loaderId ?? null;
  const errorText = navigation?.errorText ?? null;
  const deadline = now() + timeoutMs;

  let response = tracker.get(loaderId);

  while (
    response === null && errorText === null && now() < deadline
  ) {
    await sleep(intervalMs);
    response = tracker.get(loaderId);
  }

  const verdict = navigationVerdict({ errorText, response });

  return {
    url: response?.url ?? null,
    status: verdict.status,
    mimeType: response?.mimeType ?? null,
    loaderId,
    problem: verdict.problem,
    documents: tracker.size,
  };
}

/** Drive one real browser to the deployed URL and report what it rendered. */
export async function verifyPage({
  url,
  criteria,
  chrome,
  artifactsDir,
  timeoutMs = 20_000,
}) {
  Deno.mkdirSync(artifactsDir, { recursive: true });
  const { child, endpoint } = startChrome(
    chrome,
    `${artifactsDir}/chrome-profile`,
  );

  const diagnostics = {
    exceptions: [],
    consoleErrors: [],
    wasmResponses: [],
  };

  let cdp;
  try {
    const endpointUrl = await Promise.race([
      endpoint,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Chrome did not report a DevTools endpoint")),
          15_000,
        )
      ),
    ]);
    cdp = await Cdp.connect(endpointUrl);
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    const tracker = createNavigationTracker();
    cdp.onEvent((method, params) => {
      collectDiagnostic(diagnostics, method, params);
      tracker.record(method, params);
    });

    const navigateResult = await cdp.send("Page.navigate", { url }, sessionId);
    const navigation = await observeNavigation({
      tracker,
      navigation: navigateResult,
    });

    // A navigation that did not answer 200 is not a page to observe. Waiting for
    // selectors would then report the absence of a page that was never served,
    // and a 404 would be recorded as a rendered-but-incomplete application.
    const settled = navigation.problem === null
      ? await waitForRendered(cdp, sessionId, criteria, timeoutMs)
      : {
        observed: emptyObservation(),
        ready: false,
        problems: [navigation.problem],
        timedOut: false,
        elapsedMs: 0,
        attempts: 0,
        intervalMs: 0,
        timeoutMs,
      };

    const { observed } = settled;

    const readiness = {
      ready: settled.ready,
      timedOut: settled.timedOut,
      problems: settled.problems,
      attempts: settled.attempts,
      elapsedMs: settled.elapsedMs,
      timeoutMs: settled.timeoutMs,
      intervalMs: settled.intervalMs,
      skipped: navigation.problem !== null,
      observed,
    };

    try {
      const { data } = await cdp.send("Page.captureScreenshot", {
        format: "png",
      }, sessionId);
      Deno.writeFileSync(
        `${artifactsDir}/screenshot.png`,
        Uint8Array.from(atob(data), (character) => character.charCodeAt(0)),
      );
    } catch {
      // A screenshot is supplementary evidence; losing it changes no verdict.
    }

    const version = await cdp.send("Browser.getVersion");

    return {
      observed,
      readiness,
      navigation,
      browser: {
        product: version.product,
        userAgent: version.userAgent,
        exceptions: diagnostics.exceptions,
        consoleErrors: diagnostics.consoleErrors,
        wasmResponses: diagnostics.wasmResponses,
        navigation,
        readiness,
      },
    };
  } finally {
    if (cdp !== undefined) {
      try {
        await cdp.send("Browser.close");
      } catch {
        // The browser may already be gone.
      }
      cdp.close();
    }
    try {
      child.kill();
    } catch {
      // Already exited.
    }
  }
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

const USAGE = `Verify a deployed Cloudflare Worker in a real browser.

  --url URL             deployed application URL (from the deployment result)
  --worker NAME         deployed Worker name (identity of the tested instance)
  --sha SHA             source commit under test
  --criteria FILE       authorised acceptance criteria (acceptance/criteria.json)
  --out DIR             artefact directory for evidence and the screenshot
  --chrome PATH         Chrome executable
  --http-status CODE    status of the edge readiness gate's final response
  --edge-ready BOOL     whether the edge readiness gate succeeded (true/false)
  --run-id ID           workflow run id
  --run-attempt N       workflow run attempt
  --url-source TEXT     how the URL was obtained
  --deployment-id ID    deployment/version identifier, when available
  --deploy-exit CODE    exit code of the deployment command
  --expected-sha SHA    source revision the deployed build must report
  --expected-deployment ID   deployment instance the build must report
  --timeout MS          browser readiness budget (default 20000)`;

const FLAGS = new Map([
  ["--url", "url"],
  ["--worker", "workerName"],
  ["--sha", "sha"],
  ["--criteria", "criteria"],
  ["--out", "out"],
  ["--chrome", "chrome"],
  ["--http-status", "httpStatus"],
  ["--edge-ready", "edgeReady"],
  ["--run-id", "runId"],
  ["--run-attempt", "runAttempt"],
  ["--url-source", "urlSource"],
  ["--deployment-id", "deploymentId"],
  ["--deploy-exit", "deployExit"],
  ["--timeout", "timeout"],
  ["--expected-sha", "expectedSha"],
  ["--expected-deployment", "expectedDeployment"],
]);

/** Parse the verifier's arguments; unknown or missing values fail clearly. */
export function parseVerifyArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    const name = FLAGS.get(argument);
    if (name === undefined) {
      throw new Error(
        `unknown argument ${JSON.stringify(argument)}\n\n${USAGE}`,
      );
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    options[name] = value;
    index += 1;
  }

  if (options.help === true) return options;

  if (
    options.edgeReady !== undefined &&
    options.edgeReady !== "true" &&
    options.edgeReady !== "false"
  ) {
    throw new Error(
      `--edge-ready must be "true" or "false", received ${
        JSON.stringify(options.edgeReady)
      }`,
    );
  }

  for (
    const required of [
      "url",
      "workerName",
      "sha",
      "criteria",
      "out",
      "chrome",
      "expectedSha",
      "expectedDeployment",
    ]
  ) {
    if (typeof options[required] !== "string" || options[required] === "") {
      throw new Error(`missing required argument for ${required}\n\n${USAGE}`);
    }
  }

  return options;
}

/** CLI entry point; returns an exit code that is the acceptance decision. */
export async function main(
  argv = Deno.args,
  io = console,
  now = () => new Date().toISOString(),
) {
  let options;
  try {
    options = parseVerifyArgs(argv);
  } catch (error) {
    io.error(`Edge acceptance failed: ${error.message}`);
    return 1;
  }

  if (options.help === true) {
    io.log(USAGE);
    return 0;
  }

  let criteria;
  try {
    criteria = JSON.parse(Deno.readTextFileSync(options.criteria));
  } catch (error) {
    io.error(
      `Edge acceptance failed: cannot read ${options.criteria}: ${error.message}`,
    );
    return 1;
  }

  const httpStatus = options.httpStatus === undefined
    ? null
    : Number(options.httpStatus);
  const edgeReady = options.edgeReady === undefined
    ? null
    : options.edgeReady === "true";
  const context = {
    suiteVersion: criteria.suiteVersion,
    generatedAt: now(),
    sha: options.sha,
    runId: options.runId ?? null,
    runAttempt: options.runAttempt ?? null,
    workerName: options.workerName,
    expectedSha: options.expectedSha,
    expectedDeployment: options.expectedDeployment,
    url: options.url,
    urlSource: options.urlSource ?? null,
    deploymentId: options.deploymentId ?? null,
    deployExitCode: options.deployExit === undefined
      ? null
      : Number(options.deployExit),
    httpStatus,
    edgeReady,
  };

  let observed = emptyObservation();
  let browser = {};
  let navigationStatus = null;
  let assertions;

  try {
    const page = await verifyPage({
      url: options.url,
      criteria,
      chrome: options.chrome,
      artifactsDir: options.out,
      timeoutMs: options.timeout === undefined
        ? 20_000
        : Number(options.timeout),
    });
    observed = page.observed;
    browser = page.browser;
    navigationStatus = page.navigation?.status ?? null;
    assertions = evaluateAcceptance({
      criteria,
      observed,
      expectations: {
        edgeReady,
        httpStatus,
        navigationStatus,
        expectedSha: options.expectedSha,
        expectedDeployment: options.expectedDeployment,
      },
    });
  } catch (error) {
    // A browser that cannot be driven is a failed acceptance, not a skipped run.
    assertions = [{
      id: "browser.navigation",
      description: "the deployed page loads in a real browser",
      expected: options.url,
      observed: error.message,
      status: "fail",
    }];
  }

  const evidence = buildEvidence({ context, assertions, observed, browser });
  Deno.mkdirSync(options.out, { recursive: true });
  Deno.writeTextFileSync(
    `${options.out}/acceptance.json`,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );

  for (const assertion of assertions) {
    const mark = assertion.status === "pass" ? "ok  " : "FAIL";
    io.log(
      `${mark} ${assertion.id} observed=${JSON.stringify(assertion.observed)}`,
    );
  }

  // Readiness and navigation are reported separately from the assertions so a
  // timeout explains itself in the log, not only inside the evidence file.
  const readiness = browser.readiness;
  if (readiness !== undefined) {
    io.log(
      `browser readiness: ready=${readiness.ready} timedOut=${readiness.timedOut} ` +
        `attempts=${readiness.attempts} elapsedMs=${readiness.elapsedMs}` +
        (readiness.problems?.length
          ? ` problems=${JSON.stringify(readiness.problems)}`
          : ""),
    );
  }
  if (browser.navigation !== undefined || navigationStatus !== null) {
    io.log(
      `browser navigation: status=${navigationStatus} ` +
        `url=${browser.navigation?.url ?? context.url}` +
        (browser.navigation?.problem
          ? ` problem=${JSON.stringify(browser.navigation.problem)}`
          : ""),
    );
  }

  io.log(
    `edge acceptance: accepted=${evidence.accepted} worker=${context.workerName} ` +
      `sha=${context.sha} url=${context.url}`,
  );
  io.log(`evidence written to ${options.out}/acceptance.json`);

  return evidence.accepted ? 0 : 1;
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
