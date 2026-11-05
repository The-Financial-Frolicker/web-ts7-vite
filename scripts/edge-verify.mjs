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

/** Selector texts read from the rendered page. */
const OBSERVED_FIELDS = Object.freeze(["marker", "wasm", "worker", "identity"]);

/**
 * Evaluate the authorised criteria against one observation.
 *
 * Returns one entry per assertion with `status: "pass" | "fail"`. A missing
 * value is a failure, never an absence of evidence: an empty page must not
 * produce an empty assertion list that vacuously passes.
 */
export function evaluateAcceptance({ criteria, observed, expectations = {} }) {
  const assertions = [];
  const text = typeof observed.documentText === "string"
    ? observed.documentText
    : "";

  assertions.push({
    id: "http.page",
    description: "the deployed page answers with HTTP 200",
    expected: 200,
    observed: expectations.httpStatus ?? null,
    status: expectations.httpStatus === 200 ? "pass" : "fail",
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
 * Wait until the page settles: the WebAssembly result is no longer the loading
 * placeholder, or the budget expires. A timeout is not an error here — the
 * assertions decide, and they reject a still-loading page.
 */
export async function waitForRendered(cdp, sessionId, criteria, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let observed = await readTexts(cdp, sessionId, criteria);

  while (
    observed.wasm === "Loading WebAssembly..." && Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    observed = await readTexts(cdp, sessionId, criteria);
  }

  return observed;
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
    cdp.onEvent((method, params) =>
      collectDiagnostic(diagnostics, method, params)
    );
    const navigation = await cdp.send("Page.navigate", { url }, sessionId);
    if (navigation?.errorText !== undefined && navigation.errorText !== "") {
      throw new Error(`navigation failed: ${navigation.errorText}`);
    }

    const observed = await waitForRendered(cdp, sessionId, criteria, timeoutMs);

    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
    }, sessionId);
    Deno.writeFileSync(
      `${artifactsDir}/screenshot.png`,
      Uint8Array.from(atob(data), (character) => character.charCodeAt(0)),
    );

    const version = await cdp.send("Browser.getVersion");

    return {
      observed,
      browser: {
        product: version.product,
        userAgent: version.userAgent,
        exceptions: diagnostics.exceptions,
        consoleErrors: diagnostics.consoleErrors,
        wasmResponses: diagnostics.wasmResponses,
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
  --http-status CODE    status of the independent HTTP request (shell wrapper)
  --run-id ID           workflow run id
  --run-attempt N       workflow run attempt
  --url-source TEXT     how the URL was obtained
  --deployment-id ID    deployment/version identifier, when available
  --deploy-exit CODE    exit code of the deployment command
  --expected-sha SHA    source revision the deployed build must report
  --expected-deployment ID   deployment instance the build must report
  --timeout MS          browser settle budget (default 20000)`;

const FLAGS = new Map([
  ["--url", "url"],
  ["--worker", "workerName"],
  ["--sha", "sha"],
  ["--criteria", "criteria"],
  ["--out", "out"],
  ["--chrome", "chrome"],
  ["--http-status", "httpStatus"],
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
  };

  let observed = { documentText: "" };
  let browser = {};
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
    assertions = evaluateAcceptance({
      criteria,
      observed,
      expectations: {
        httpStatus,
        expectedSha: options.expectedSha,
        expectedDeployment: options.expectedDeployment,
      },
    });
  } catch (error) {
    // A page that cannot be reached is a failed acceptance, not a skipped run.
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
