/**
 * Tests for the edge readiness gate and for concurrent acceptance-run isolation.
 *
 * Two questions are covered without a Cloudflare account:
 *
 *   1. Does the gate wait for the *deployment* (HTTP 200 and the application
 *      this run deployed) instead of accepting whatever Cloudflare answers
 *      first? The real polling loop is exercised by sourcing
 *      `scripts/edge-readiness.sh` and replacing `probe_once`, the single
 *      network seam — no classification, timing or reporting step is
 *      reimplemented for the test.
 *   2. Can two overlapping runs deploy, verify and clean up independently? The
 *      workflow's run-scoped identities are read out of
 *      `.github/workflows/edge-acceptance.yml` and rendered for two runs, so the
 *      isolation claims are checked against the file that actually runs.
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

const projectRoot = path.resolve(import.meta.dirname, "..");
const readinessScript = path.join(projectRoot, "scripts", "edge-readiness.sh");
const workflowPath = path.join(
  projectRoot,
  ".github",
  "workflows",
  "edge-acceptance.yml",
);

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTemporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "edge-readiness-"));
  temporaryRoots.push(root);
  return root;
}

/** The application the deployed Worker serves, with its title and mount point. */
function applicationHtml(workerName, { mountPoint = true } = {}) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    `    <title>${workerName}</title>`,
    "  </head>",
    "  <body>",
    mountPoint ? '    <div id="app"></div>' : "    <p>Nothing here yet</p>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");
}

/** Cloudflare's own "not ready yet" answer while a Worker propagates. */
function cloudflareErrorHtml(code = 1042) {
  return [
    "<!doctype html>",
    "<html><head><title>Error</title></head><body>",
    "<h1>Worker error</h1>",
    `<p>error code: ${code}</p>`,
    "</body></html>",
    "",
  ].join("\n");
}

/**
 * Source the real gate, replace only its network seam, and poll.
 *
 * The scripted answers are numbered directories (`1`, `2`, ...) holding
 * `status` and `body`; once they run out the last one repeats, which is how a
 * persistent failure is expressed.
 */
const DRIVER = `set -uo pipefail
source "$EDGE_READINESS_SCRIPT"

# The counter lives in a file because the gate reads the probe inside a command
# substitution: a shell variable would lose its increment in that subshell.
probe_once() {
    local body_file="$2"
    local counter
    counter=$(( $(cat "$COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
    printf '%s\\n' "$counter" > "$COUNTER_FILE"

    local answer="$SCENARIO/$counter"
    if [[ ! -d "$answer" ]]; then
        answer="$SCENARIO/last"
    fi
    cp "$answer/body" "$body_file"
    cat "$answer/status"
}

poll_edge_readiness "$URL" "$WORKER" "$OUT" "$TIMEOUT_MS" "$INTERVAL"
echo "READINESS_EXIT=$?"
`;

/** Is curl available? The gate's real network seam uses it. */
function curlAvailable() {
  try {
    return new Deno.Command("curl", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).outputSync().code === 0;
  } catch {
    return false;
  }
}

describe("edge readiness against a live endpoint", () => {
  it("waits through a real 1042 answer and stops at the real application", {
    skip: curlAvailable() ? false : "curl is not available",
  }, async () => {
    // Deterministic on purpose: the endpoint is this process, so there is no
    // Cloudflare propagation and no dependence on wall-clock timing beyond the
    // gate's own budget.
    const answers = [
      {
        status: 500,
        body: cloudflareErrorHtml(1042),
      },
      {
        status: 200,
        body: applicationHtml("edge-live-1"),
      },
    ];

    let served = 0;
    const { promise, resolve } = Promise.withResolvers();
    const controller = new AbortController();
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      signal: controller.signal,
      onListen: resolve,
    }, () => {
      const answer = answers[Math.min(served, answers.length - 1)];
      served += 1;
      return new Response(answer.body, {
        status: answer.status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    try {
      const { hostname, port } = await promise;
      const root = makeTemporaryRoot();
      const out = path.join(root, "artifacts");

      const { code } = await new Deno.Command("bash", {
        args: [
          readinessScript,
          "--url",
          `http://${hostname}:${port}/`,
          "--worker",
          "edge-live-1",
          "--out",
          out,
          "--timeout-ms",
          "5000",
          "--interval",
          "0.05",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();

      assert.equal(code, 0);

      const report = JSON.parse(
        readFileSync(path.join(out, "edge-readiness.json"), "utf8"),
      );
      assert.equal(report.ready, true);
      assert.equal(report.finalStatus, 200);
      assert.equal(report.attempts.length, 2);
      assert.equal(report.attempts[0].status, 500);
      assert.equal(report.attempts[0].cloudflareErrorCode, 1042);
      assert.equal(report.attempts[0].retryable, true);
      assert.equal(
        readFileSync(path.join(out, "page.html"), "utf8"),
        applicationHtml("edge-live-1"),
      );
    } finally {
      controller.abort();
      await server.finished;
    }
  });
});

function scriptScenario(root, answers) {
  const scenario = path.join(root, "scenario");

  answers.forEach((answer, index) => {
    const directory = path.join(scenario, String(index + 1));
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "status"), `${answer.status}\n`);
    writeFileSync(path.join(directory, "body"), answer.body);
  });

  const last = path.join(scenario, "last");
  mkdirSync(last, { recursive: true });
  const final = answers.at(-1);
  writeFileSync(path.join(last, "status"), `${final.status}\n`);
  writeFileSync(path.join(last, "body"), final.body);

  return scenario;
}

/** Run the real gate against scripted answers and read back its report. */
function pollScripted({
  answers,
  worker = "edge-1000-1",
  timeoutMs = 800,
  interval = "0.05",
}) {
  const root = makeTemporaryRoot();
  const scenario = scriptScenario(root, answers);
  const out = path.join(root, "artifacts");
  const driverPath = path.join(root, "driver.sh");
  writeFileSync(driverPath, DRIVER, { mode: 0o755 });

  const command = new Deno.Command("bash", {
    args: [driverPath],
    env: {
      EDGE_READINESS_SCRIPT: readinessScript,
      SCENARIO: scenario,
      COUNTER_FILE: path.join(root, "counter"),
      URL: "https://edge-1000-1.example.workers.dev",
      WORKER: worker,
      OUT: out,
      TIMEOUT_MS: String(timeoutMs),
      INTERVAL: interval,
      TMPDIR: root,
    },
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = command.outputSync();
  const decoder = new TextDecoder();

  return {
    root,
    out,
    exit: code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
    report: JSON.parse(
      readFileSync(path.join(out, "edge-readiness.json"), "utf8"),
    ),
    page: readFileSync(path.join(out, "page.html"), "utf8"),
  };
}

describe("edge readiness gate", () => {
  it("treats a transient 1042 followed by HTTP 200 as ready", () => {
    const result = pollScripted({
      answers: [
        { status: "500", body: cloudflareErrorHtml(1042) },
        { status: "502", body: "<html><body>Bad gateway</body></html>" },
        { status: "200", body: applicationHtml("edge-1000-1") },
      ],
    });

    assert.equal(result.exit, 0);
    assert.match(result.stdout, /READINESS_EXIT=0/);

    const { report } = result;
    assert.equal(report.ready, true);
    assert.equal(report.timedOut, false);
    assert.equal(report.finalStatus, 200);
    assert.equal(report.attempts.length, 3);

    assert.deepEqual(
      report.attempts.map((attempt) => attempt.status),
      [500, 502, 200],
    );
    assert.deepEqual(
      report.attempts.map((attempt) => attempt.retryable),
      [true, true, false],
    );
    assert.equal(report.attempts[0].cloudflareErrorCode, 1042);
    assert.match(
      report.attempts[0].diagnostic,
      /Cloudflare error 1042/,
      "the diagnostic names what Cloudflare actually answered",
    );
    assert.equal(report.attempts[2].diagnostic, null);

    // Every attempt is timed, and the history is ordered.
    for (const attempt of report.attempts) {
      assert.equal(typeof attempt.elapsedMs, "number");
    }
    assert.ok(
      report.attempts[2].elapsedMs >= report.attempts[0].elapsedMs,
      "elapsed time grows across attempts",
    );

    // The page that was actually accepted is the one kept as evidence.
    assert.equal(result.page, applicationHtml("edge-1000-1"));
  });

  it("reaches the timeout and fails when 1042 persists", () => {
    const result = pollScripted({
      answers: [{ status: "500", body: cloudflareErrorHtml(1042) }],
      timeoutMs: 300,
      interval: "0.05",
    });

    assert.match(result.stdout, /READINESS_EXIT=1/);

    const { report } = result;
    assert.equal(report.ready, false);
    assert.equal(report.timedOut, true);
    assert.equal(report.finalStatus, 500);
    assert.ok(
      report.attempts.length >= 2,
      "the gate retries instead of giving up",
    );
    assert.ok(report.elapsedMs >= 300, "the wait is bounded, not skipped");
    assert.ok(report.elapsedMs < 10_000, "the wait is bounded, not unbounded");

    for (const attempt of report.attempts) {
      assert.equal(attempt.ready, false);
      assert.equal(attempt.retryable, true);
      assert.equal(attempt.cloudflareErrorCode, 1042);
    }

    // The failure is explicit: the reason and the history are reported.
    assert.match(result.stderr, /NOT READY/);
    assert.match(result.stderr, /Cloudflare error 1042/);
    assert.match(result.stderr, /edge-readiness\.json/);
    assert.equal(result.page, cloudflareErrorHtml(1042));
  });

  it("does not accept an HTTP 200 that is not this deployment", () => {
    const wrongTitle = pollScripted({
      worker: "edge-1000-1",
      answers: [{ status: "200", body: applicationHtml("edge-9999-1") }],
      timeoutMs: 150,
      interval: "0.05",
    });

    assert.match(wrongTitle.stdout, /READINESS_EXIT=1/);
    assert.equal(wrongTitle.report.ready, false);
    assert.match(
      wrongTitle.report.attempts[0].diagnostic,
      /<title> is not edge-1000-1/,
    );
    assert.equal(
      wrongTitle.report.attempts[0].retryable,
      false,
      "a 200 from another deployment is not a propagation delay",
    );

    const wrongPage = pollScripted({
      answers: [{
        status: "200",
        body: applicationHtml("edge-1000-1", { mountPoint: false }),
      }],
      timeoutMs: 150,
      interval: "0.05",
    });

    assert.equal(wrongPage.report.ready, false);
    assert.match(wrongPage.report.attempts[0].diagnostic, /#app mount point/);
  });

  it("retries a missing response and records it as such", () => {
    const result = pollScripted({
      answers: [
        { status: "000", body: "" },
        { status: "200", body: applicationHtml("edge-1000-1") },
      ],
    });

    assert.match(result.stdout, /READINESS_EXIT=0/);
    assert.equal(result.report.ready, true);
    assert.equal(result.report.attempts[0].status, null);
    assert.equal(result.report.attempts[0].rawStatus, "000");
    assert.equal(result.report.attempts[0].retryable, true);
    assert.match(result.report.attempts[0].diagnostic, /no HTTP response/);
    assert.equal(result.report.attempts.length, 2);
  });

  it("rejects a non-numeric budget instead of polling forever", () => {
    const root = makeTemporaryRoot();
    const command = new Deno.Command("bash", {
      args: [
        readinessScript,
        "--url",
        "https://edge-1000-1.example.workers.dev",
        "--worker",
        "edge-1000-1",
        "--out",
        path.join(root, "artifacts"),
        "--timeout-ms",
        "soon",
      ],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stderr } = command.outputSync();
    assert.equal(code, 2);
    assert.match(new TextDecoder().decode(stderr), /--timeout-ms/);
    assert.equal(existsSync(path.join(root, "artifacts")), false);
  });
});

/* ------------------------------------------------------------------------- *
 * Concurrent acceptance runs
 *
 * The workflow is the only place a real deployment happens, so the isolation
 * claims are read out of it and rendered for two overlapping runs. Nothing is
 * inferred from "it probably uses a unique name": the run-scoped identities and
 * the teardown target are asserted against the file that runs in Actions.
 * ------------------------------------------------------------------------- */

describe("concurrent acceptance-run isolation", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  function declaration(pattern, label) {
    const match = pattern.exec(workflow);
    assert.ok(
      match,
      `${label} is not declared in ${path.basename(workflowPath)}`,
    );
    return match[1];
  }

  // `[ \t]` rather than `\s`: with the `m` flag `\s` would cross lines and match
  // the next key, hiding a missing declaration.
  const workerTemplate = declaration(
    /^[ \t]*WORKER_NAME:[ \t]*(.+?)[ \t]*$/m,
    "WORKER_NAME",
  );
  const workDirTemplate = declaration(
    /^[ \t]*WORK_DIR:[ \t]*(.+?)[ \t]*$/m,
    "WORK_DIR",
  );
  const artifactTemplate = declaration(
    /^[ \t]*name:[ \t]*(edge-acceptance-.+?)[ \t]*$/m,
    "the artefact name",
  );
  const buildDeploymentLine = declaration(
    /^[ \t]*export BUILD_DEPLOYMENT=(.+?)[ \t]*$/m,
    "BUILD_DEPLOYMENT",
  );

  function render(value, run) {
    return value
      .replaceAll("${{ github.run_id }}", run.runId)
      .replaceAll("${{ github.run_attempt }}", run.runAttempt)
      .replaceAll("${{ github.workspace }}", run.workspace)
      .replaceAll("${{ runner.temp }}", run.runnerTemp);
  }

  /** True when `candidate` is `parent` or lies inside it. */
  function isWithin(candidate, parent) {
    return candidate === parent || candidate.startsWith(`${parent}/`);
  }

  function identity(run) {
    return {
      workerName: render(workerTemplate, run),
      workDir: render(workDirTemplate, run),
      artifact: render(artifactTemplate, run),
    };
  }

  const workspace = "/home/runner/work/web-ts7-vite/web-ts7-vite";
  const runnerTemp = "/home/runner/work/_temp";
  const firstRun = {
    runId: "42109653598",
    runAttempt: "1",
    workspace,
    runnerTemp,
  };
  const secondRun = {
    runId: "42109653599",
    runAttempt: "1",
    workspace,
    runnerTemp,
  };
  const reRun = {
    runId: "42109653598",
    runAttempt: "2",
    workspace,
    runnerTemp,
  };

  it("gives each overlapping run its own Worker and artefact", () => {
    const first = identity(firstRun);
    const second = identity(secondRun);
    const attemptTwo = identity(reRun);

    assert.equal(first.workerName, "edge-42109653598-1");
    assert.equal(second.workerName, "edge-42109653599-1");
    assert.equal(attemptTwo.workerName, "edge-42109653598-2");

    assert.equal(first.artifact, "edge-acceptance-42109653598-1");
    assert.equal(second.artifact, "edge-acceptance-42109653599-1");

    // Concurrency, not luck: any two runs differ, and a re-run of the same run
    // id is a third deployment rather than a second use of the first one.
    assert.ok(first.workerName !== second.workerName);
    assert.ok(first.workerName !== attemptTwo.workerName);
    assert.ok(first.artifact !== second.artifact);
    assert.ok(first.artifact !== attemptTwo.artifact);
  });

  it("keeps each run's working tree outside the checkout it is copied from", () => {
    // The prepare step archives the checkout *into* this directory. A
    // destination inside its own source makes the producing tar read a
    // directory the extracting tar is still filling, which fails intermittently
    // with `tar: ./.acceptance: file changed as we read it`. The runner's
    // temporary directory is disjoint from the workspace by construction.
    assert.match(workDirTemplate, /\$\{\{ runner\.temp \}\}/);
    assert.doesNotMatch(
      workDirTemplate,
      /github\.workspace/,
      "the working tree must not be placed inside the archived checkout",
    );

    const working = identity(firstRun).workDir;
    assert.equal(working, "/home/runner/work/_temp/acceptance-42109653598-1");
    assert.ok(
      !isWithin(working, workspace),
      `the working tree must stay outside the archive source: ${working}`,
    );

    // Still run-scoped: overlapping runs and a re-run never share a tree.
    assert.ok(identity(firstRun).workDir !== identity(secondRun).workDir);
    assert.ok(identity(firstRun).workDir !== identity(reRun).workDir);

    // The acceptance step must run relative to that tree, or the deployment and
    // the evidence would be written outside the run that produced them.
    const acceptanceStep = workflow.slice(
      workflow.indexOf(
        "- name: Edge acceptance (real browser, real deployment)",
      ),
    );
    assert.ok(acceptanceStep.length > 0, "the acceptance step is missing");
    assert.match(acceptanceStep, /cd "\$WORK_DIR"/);
    assert.match(acceptanceStep, /bash scripts\/edge-accept\.sh/);
    // The deployment log is derived from that declaration, not restated.
    assert.match(
      acceptanceStep,
      /export DEPLOY_LOG="\$WORK_DIR\/deploy\.log"/,
    );
  });

  it("archives the checkout into a destination it cannot contain", () => {
    const prepareIndex = workflow.indexOf(
      "- name: Prepare a disposable deployment tree",
    );
    const deployIndex = workflow.indexOf(
      "- name: Build and deploy the disposable Worker",
    );
    assert.ok(prepareIndex > 0, "the prepare step is missing");
    assert.ok(
      deployIndex > prepareIndex,
      "the prepare step must precede deploy",
    );

    const prepare = workflow.slice(prepareIndex, deployIndex);
    // Source and destination are named explicitly, and they are different paths.
    assert.match(prepare, /tar -C "\$GITHUB_WORKSPACE"/);
    assert.match(prepare, /tar -C "\$WORK_DIR" -xf -/);

    const source = workspace;
    const destination = identity(firstRun).workDir;
    assert.ok(
      !isWithin(destination, source),
      `the archive destination must not sit inside its source: ${destination}`,
    );
    assert.ok(
      !isWithin(source, destination),
      `the archive source must not sit inside its destination: ${source}`,
    );
  });

  it("derives every acceptance path from the single WORK_DIR declaration", () => {
    assert.doesNotMatch(
      workflow,
      /github\.workspace \}\}\/\.acceptance/,
      "no step may restate the old in-checkout acceptance path",
    );

    const upload = workflow.slice(
      workflow.indexOf("- name: Keep the acceptance evidence"),
    );
    assert.doesNotMatch(upload, /github\.workspace/);
    assert.match(upload, /path: \|\n\s+\$\{\{ env\.WORK_DIR \}\}\/artifacts\//);
    for (const name of ["acceptance.json", "cleanup.json", "page.html"]) {
      assert.ok(
        upload.includes(`\${{ env.WORK_DIR }}/artifacts/${name}`),
        `the uploaded evidence must come from WORK_DIR: ${name}`,
      );
    }
    assert.ok(upload.includes("${{ env.WORK_DIR }}/deploy.log"));
  });

  it("deploys the generated configuration instead of a second name argument", () => {
    const deployIndex = workflow.indexOf(
      "- name: Build and deploy the disposable Worker",
    );
    const acceptanceIndex = workflow.indexOf(
      "- name: Edge acceptance (real browser, real deployment)",
    );
    assert.ok(deployIndex > 0, "the deploy step is missing");
    assert.ok(
      acceptanceIndex > deployIndex,
      "the acceptance step must follow the deploy step",
    );

    // Comments explain the contract; only commands are inspected.
    const step = workflow
      .slice(deployIndex, acceptanceIndex)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
      .replace(/\\\s*\n\s*/g, " ")
      .replace(/[ \t]+/g, " ");

    assert.match(
      step,
      /deno task deploy/,
      "the deploy step must run the Deno-owned deployment task",
    );

    // `buildWranglerDeployArgs` replaces its default `deploy --config …` with
    // whatever list it receives, so an argument here would remove the generated
    // configuration from the invocation instead of adding to it, and `--name`
    // would duplicate the identity the initialised tree already carries.
    assert.doesNotMatch(
      step,
      /deno task deploy[^|]*--/,
      `no Wrangler argument may follow the deployment task:\n${step}`,
    );
    assert.doesNotMatch(
      step,
      /--name/,
      "the Worker name must come from the generated configuration",
    );

    // That one identity is still established by the initialiser and still
    // reaches the page, so the browser verifier keeps binding to this run.
    const prepare = workflow.slice(
      workflow.indexOf("- name: Prepare a disposable deployment tree"),
      deployIndex,
    );
    assert.match(
      prepare,
      /deno task init:project "\$WORKER_NAME"/,
      "the generated configuration must carry this run's Worker name",
    );
    assert.match(step, /export BUILD_DEPLOYMENT="\$WORKER_NAME"/);
  });

  it("scopes cleanup to the Worker this run created", () => {
    const cleanupIndex = workflow.indexOf(
      "- name: Delete the disposable Worker and verify it is gone",
    );
    assert.ok(cleanupIndex > 0, "the cleanup step is missing");

    const cleanup = workflow.slice(cleanupIndex);
    const flat = cleanup
      .replace(/\\\s*\n\s*/g, " ")
      .replace(/[ \t]+/g, " ");

    // The step delegates to the tested script and hands it only the disposable
    // name and the artefact directory; the script reads the credentials from the
    // environment.
    assert.ok(
      flat.includes(
        'bash scripts/edge-cleanup.sh --worker "$WORKER_NAME" --out "$WORK_DIR/artifacts"',
      ),
      `cleanup must delete exactly the run's own Worker:\n${flat}`,
    );

    // `wrangler delete` is gone on purpose: it exits non-zero after a successful
    // deletion because of an unrelated KV-namespace post-check. The comment above
    // the step may explain that; no *command* may invoke it.
    const commands = workflow
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    assert.doesNotMatch(
      commands,
      /wrangler delete|wrangler\.js" delete/,
      "cleanup must not shell out to wrangler delete",
    );

    // No enumeration and no pattern can appear anywhere in the workflow. The
    // match is a standalone argument: `--allow-download` (a Deno provisioning
    // flag) must not be mistaken for a `--all` Worker-deletion flag.
    assert.doesNotMatch(
      workflow,
      /(^|\s)--all(\s|$)/m,
      "cleanup must not delete every Worker",
    );
    assert.doesNotMatch(workflow, /edge-\*/, "cleanup must not use a pattern");
    assert.doesNotMatch(
      flat,
      /--worker "(?!\$WORKER_NAME)/,
      "cleanup must name no other Worker literally",
    );

    // The verdict is explicit, and it cannot change the acceptance verdict.
    assert.match(flat, /continue-on-error: true/);
    assert.match(flat, /cleanup_exit=\$status/);
    assert.match(flat, /cleanup_classification=\$classification/);
    assert.match(flat, /GITHUB_STEP_SUMMARY/);
    assert.match(flat, /--evidence "\$WORK_DIR\/artifacts\/acceptance\.json"/);
  });

  it("binds the deployed page to the run's own deployment identity", () => {
    // Without this, a page from another run's Worker could satisfy the marker
    // and WASM assertions; the observer asserts the identity it observed.
    assert.equal(buildDeploymentLine, '"$WORKER_NAME"');
    assert.match(
      readFileSync(
        path.join(projectRoot, "scripts", "edge-accept.sh"),
        "utf8",
      ),
      /--expected-deployment "\$WORKER_NAME"/,
    );
  });

  it("uploads the evidence after cleanup and records the cleanup outcome", () => {
    const cleanupIndex = workflow.indexOf(
      "- name: Delete the disposable Worker and verify it is gone",
    );
    const uploadIndex = workflow.indexOf(
      "- name: Keep the acceptance evidence",
    );

    assert.ok(uploadIndex > 0, "the evidence upload step is missing");
    assert.ok(
      cleanupIndex < uploadIndex,
      "cleanup must run before the evidence is uploaded",
    );

    const upload = workflow.slice(uploadIndex);
    for (
      const name of [
        "acceptance.json",
        "edge-readiness.json",
        "cleanup.json",
        "page.html",
        "deploy.log",
      ]
    ) {
      assert.ok(
        upload.includes(name),
        `the uploaded evidence is missing ${name}`,
      );
    }
    assert.match(upload, /if: always\(\)/);
    assert.match(
      workflow.slice(cleanupIndex, uploadIndex),
      /if: always\(\)/,
      "cleanup must run even when acceptance failed",
    );
  });

  it("queues overlapping dispatches on one ref instead of cancelling them", () => {
    // GitHub Actions allows overlap in general; this repository serialises
    // same-ref dispatches by queueing. That is a scheduling property, not the
    // isolation mechanism — the identities above are — and asserting it keeps a
    // future edit from turning a queued run into a cancelled one mid-teardown.
    assert.match(
      workflow,
      /concurrency:\s*\n\s*group: edge-acceptance-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/,
    );
  });
});
