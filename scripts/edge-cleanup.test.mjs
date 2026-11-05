/**
 * Tests for the disposable-Worker cleanup.
 *
 * Every test drives the real `scripts/edge-cleanup.sh` with a `curl` stand-in
 * first on `PATH`. That stand-in replays scripted responses and records both the
 * request line and its full argument vector, so the tests can prove what the
 * script asked Cloudflare to do without ever opening a connection.
 *
 * Three independent guards make an accidental real mutation impossible:
 *
 *   1. `curl` never resolves to the real binary: the stand-in is prepended to
 *      `PATH` and performs no I/O;
 *   2. `CLOUDFLARE_API_TOKEN` is replaced with a literal placeholder, so even a
 *      stray real request could not authenticate;
 *   3. the target names are synthetic and absent from any account.
 */
import assert from "./lib/assert.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const cleanupScript = path.join(projectRoot, "scripts", "edge-cleanup.sh");

const ACCOUNT = "fa4129115b6a391af4fb31c54a7015da";
const WORKER = "edge-42109653598-1";
const OTHER_WORKER = "edge-42109802914-1";
const TOKEN = "tok_SENTINEL_0123456789abcdef";

const API_BASE = "https://api.cloudflare.com/client/v4";
const DELETE_URL =
  `${API_BASE}/accounts/${ACCOUNT}/workers/scripts/${WORKER}?force=true`;
const VERIFY_URL =
  `${API_BASE}/accounts/${ACCOUNT}/workers/scripts/${WORKER}/settings`;

const ABSENT_BODY = JSON.stringify({
  success: false,
  errors: [{
    code: 10007,
    message: "This Worker does not exist on your account.",
  }],
  result: null,
});
const ERROR_10000_BODY = JSON.stringify({
  success: false,
  errors: [{ code: 10000, message: "Authentication error" }],
  result: null,
});
const SETTINGS_BODY = JSON.stringify({
  success: true,
  result: { bindings: [], compatibility_date: "2026-10-30" },
  errors: [],
});

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTemporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "edge-cleanup-"));
  temporaryRoots.push(root);
  return root;
}

/**
 * A `curl` stand-in: records the request, replays a scripted answer, never
 * connects anywhere.
 *
 * The scenario is a directory of numbered answers (`1`, `2`, …), each holding
 * `status`, `body` and `exit`; `last` repeats once the numbered ones run out.
 */
const FAKE_CURL = `set -uo pipefail

# Captured before the argument loop consumes the positional parameters.
argv="$*"
method=""
url=""
output=""
while (( $# > 0 )); do
    case "$1" in
        --config) shift 2 ;;
        --request) method="$2"; shift 2 ;;
        --connect-timeout | --max-time | --write-out) shift 2 ;;
        --output) output="$2"; shift 2 ;;
        --url) url="$2"; shift 2 ;;
        -sS) shift ;;
        *) shift ;;
    esac
done

printf '%s %s\\n' "$method" "$url" >> "$FAKE_CURL_LOG"
printf '%s\\n' "$argv" >> "$FAKE_CURL_ARGV_LOG"

count=0
if [[ -f "$FAKE_CURL_COUNTER" ]]; then
    count="$(cat "$FAKE_CURL_COUNTER")"
fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_CURL_COUNTER"

answer="$FAKE_CURL_SCENARIO/$count"
if [[ ! -d "$answer" ]]; then
    answer="$FAKE_CURL_SCENARIO/last"
fi

if [[ -n "$output" ]]; then
    cp "$answer/body" "$output"
fi
cat "$answer/status"
exit "$(cat "$answer/exit" 2>/dev/null || echo 0)"
`;

function writeAnswer(directory, answer) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "status"), `${answer.status}\n`);
  writeFileSync(path.join(directory, "body"), answer.body ?? "");
  writeFileSync(path.join(directory, "exit"), `${answer.exitCode ?? 0}\n`);
}

/** Turn a list of scripted answers into a scenario directory. */
function scriptScenario(root, answers) {
  const scenario = path.join(root, "scenario");

  answers.forEach((answer, index) => {
    writeAnswer(path.join(scenario, String(index + 1)), answer);
  });
  writeAnswer(path.join(scenario, "last"), answers.at(-1));

  return scenario;
}

/**
 * Run the real script against scripted answers.
 *
 * `args` may override or extend the default invocation; `env` may override the
 * credentials, which is how the refusal paths are exercised.
 */
function runCleanup({
  answers = [{ status: "200", body: "" }, { status: "404", body: ABSENT_BODY }],
  args = [],
  env = {},
  worker = WORKER,
  evidence,
} = {}) {
  const root = makeTemporaryRoot();
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, "curl"), FAKE_CURL, { mode: 0o755 });

  const outDir = path.join(root, "artifacts");
  const requestsLog = path.join(root, "requests.log");
  const argvLog = path.join(root, "argv.log");
  const scenarioDir = scriptScenario(root, answers);

  const commandArgs = [
    cleanupScript,
    "--worker",
    worker,
    "--out",
    outDir,
    "--max-attempts",
    "3",
    "--retry-delay",
    "0",
    ...args,
  ];

  if (evidence !== undefined) {
    const evidencePath = path.join(root, "acceptance.json");
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    commandArgs.push("--evidence", evidencePath);
  }

  const command = new Deno.Command("bash", {
    args: commandArgs,
    env: {
      PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
      FAKE_CURL_SCENARIO: scenarioDir,
      FAKE_CURL_LOG: requestsLog,
      FAKE_CURL_ARGV_LOG: argvLog,
      FAKE_CURL_COUNTER: path.join(root, "counter"),
      CLOUDFLARE_API_TOKEN: TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      TMPDIR: root,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = command.outputSync();
  const decoder = new TextDecoder();

  const readLines = (file) => {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter((line) =>
      line.trim() !== ""
    );
  };

  const reportPath = path.join(outDir, "cleanup.json");
  const evidencePath = path.join(root, "acceptance.json");

  return {
    root,
    outDir,
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
    requests: readLines(requestsLog).map((line) => {
      const [method, url] = line.split(" ");
      return { method, url };
    }),
    curlArgs: readLines(argvLog),
    reportExists: existsSync(reportPath),
    report: existsSync(reportPath)
      ? JSON.parse(readFileSync(reportPath, "utf8"))
      : null,
    evidence: existsSync(evidencePath)
      ? JSON.parse(readFileSync(evidencePath, "utf8"))
      : null,
  };
}

/** The evidence contract: the fields the workflow and a reviewer rely on. */
function assertReportShape(report, expected) {
  assert.equal(report.worker, expected.worker ?? WORKER);
  assert.equal(report.ok, expected.ok);
  assert.equal(report.classification, expected.classification);
  assert.equal(
    "diagnostic" in report,
    true,
    "the record must state a diagnostic, even when it is null",
  );
  assert.match(report.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(typeof report.durationMs, "number");
  assert.equal(report.deletion.method, "DELETE");
  assert.equal(report.deletion.attempted, expected.deleteAttempted ?? true);
  assert.equal(report.deletion.httpStatus, expected.deleteStatus ?? null);
  assert.equal(report.deletion.force, true);
  assert.equal(report.verification.method, "GET");
  assert.equal(report.verification.attempted, expected.verifyAttempted ?? true);
  assert.equal(report.verification.httpStatus, expected.verifyStatus ?? null);
  assert.equal(report.verification.absent, expected.verifyStatus === 404);
}

describe("cleanup of a disposable Worker", () => {
  it("deletes the Worker and confirms its absence", () => {
    const result = runCleanup({
      answers: [
        { status: "200", body: "" },
        { status: "404", body: ABSENT_BODY },
      ],
    });

    assert.equal(result.code, 0);
    assert.equal(result.reportExists, true);
    assertReportShape(result.report, {
      ok: true,
      classification: "deleted-and-absent",
      deleteStatus: 200,
      verifyStatus: 404,
    });
    assert.equal(result.report.diagnostic, null);
    assert.equal(result.report.deletion.attempts.length, 1);
    assert.equal(result.report.verification.attempts.length, 1);
    assert.equal(
      result.report.verification.attempts[0].cloudflareErrorCode,
      10007,
    );
    assert.match(result.stdout, /is gone/);

    // Exactly one deletion and one verification, in that order.
    assert.deepEqual(result.requests, [
      { method: "DELETE", url: DELETE_URL },
      { method: "GET", url: VERIFY_URL },
    ]);
  });

  it("accepts a Worker that was already absent", () => {
    const result = runCleanup({
      answers: [
        { status: "404", body: ABSENT_BODY },
        { status: "404", body: ABSENT_BODY },
      ],
    });

    assert.equal(result.code, 0, result.stderr);
    assertReportShape(result.report, {
      ok: true,
      classification: "already-absent",
      deleteStatus: 404,
      verifyStatus: 404,
    });
    assert.match(result.report.diagnostic, /deletion answered HTTP 404/);
  });

  it("retries a transient deletion failure and then succeeds", () => {
    const result = runCleanup({
      answers: [
        { status: "503", body: "<html>service unavailable</html>" },
        { status: "200", body: "" },
        { status: "404", body: ABSENT_BODY },
      ],
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.report.classification, "deleted-and-absent");
    assert.equal(result.report.deletion.attempts.length, 2);
    assert.equal(result.report.deletion.attempts[0].httpStatus, 503);
    assert.equal(result.report.deletion.attempts[0].retryable, true);
    assert.equal(result.report.deletion.attempts[1].httpStatus, 200);
  });

  it("waits, within its budget, for a deletion to become visible", () => {
    const result = runCleanup({
      answers: [
        { status: "200", body: "" },
        { status: "200", body: SETTINGS_BODY },
        { status: "404", body: ABSENT_BODY },
      ],
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.report.classification, "deleted-and-absent");
    assert.equal(result.report.verification.attempts.length, 2);
    assert.equal(result.report.verification.attempts[0].httpStatus, 200);
    assert.equal(result.report.verification.attempts[0].retryable, true);
  });

  it("attaches the record to the acceptance evidence without judging it", () => {
    const existing = {
      schemaVersion: 1,
      accepted: false,
      assertions: [{ id: "page.marker", status: "fail" }],
      edgeReadiness: { ready: false },
    };

    const result = runCleanup({ evidence: existing });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.evidence.accepted,
      false,
      "the verdict is not recomputed",
    );
    assert.deepEqual(result.evidence.assertions, existing.assertions);
    assert.deepEqual(result.evidence.edgeReadiness, existing.edgeReadiness);
    assert.deepEqual(result.evidence.cleanup, result.report);
  });
});

describe("cleanup that must be reported as a failure", () => {
  it("fails when the Worker still exists after a successful delete request", () => {
    const result = runCleanup({
      answers: [
        { status: "200", body: "" },
        { status: "200", body: SETTINGS_BODY },
      ],
    });

    assert.equal(result.code, 1);
    assertReportShape(result.report, {
      ok: false,
      classification: "still-present",
      deleteStatus: 200,
      verifyStatus: 200,
    });
    // The deletion request said 200; the independent read overrides it.
    assert.equal(result.report.deletion.attempts.length, 1);
    assert.equal(result.report.verification.attempts.length, 3);
    assert.match(result.report.diagnostic, /still exists/);
    assert.match(result.stderr, /FAILED still-present/);
  });

  it("fails on an authentication error and keeps the Cloudflare code", () => {
    const result = runCleanup({
      answers: [
        { status: "401", body: ERROR_10000_BODY },
        { status: "401", body: ERROR_10000_BODY },
      ],
    });

    assert.equal(result.code, 1);
    assertReportShape(result.report, {
      ok: false,
      classification: "authentication-failed",
      deleteStatus: 401,
      verifyStatus: 401,
    });
    assert.equal(
      result.report.verification.attempts[0].cloudflareErrorCode,
      10000,
    );
    assert.equal(
      result.report.verification.attempts[0].cloudflareErrorMessage,
      "Authentication error",
    );
    assert.match(result.report.diagnostic, /unauthenticated/);
  });

  it("fails on a permission error", () => {
    const result = runCleanup({
      answers: [
        { status: "403", body: ERROR_10000_BODY },
        { status: "403", body: ERROR_10000_BODY },
      ],
    });

    assert.equal(result.code, 1);
    assertReportShape(result.report, {
      ok: false,
      classification: "permission-failed",
      deleteStatus: 403,
      verifyStatus: 403,
    });
    assert.match(result.report.diagnostic, /not allowed to read this Worker/);
  });

  it("fails on an unexpected response without losing the evidence", () => {
    const result = runCleanup({
      answers: [
        { status: "200", body: "" },
        { status: "400", body: "not-json-at-all" },
      ],
    });

    assert.equal(result.code, 1);
    assert.equal(result.reportExists, true);
    assertReportShape(result.report, {
      ok: false,
      classification: "unexpected-response",
      deleteStatus: 200,
      verifyStatus: 400,
    });
    assert.equal(
      result.report.verification.attempts[0].cloudflareErrorCode,
      null,
      "a body outside the JSON envelope records no error code",
    );
  });

  it("fails when the API answers with something that is not a status", () => {
    // A proxy or a truncated response must not abort the report: the evidence of
    // the unexpected answer is the point of writing it.
    const result = runCleanup({
      answers: [
        { status: "200", body: "" },
        { status: "not-a-status", body: "" },
      ],
    });

    assert.equal(result.code, 1);
    assert.equal(result.reportExists, true);
    assert.equal(result.report.classification, "unexpected-response");
    assert.equal(result.report.verification.httpStatus, null);
    assert.equal(result.report.verification.rawStatus, "not-a-status");
  });

  it("exhausts its bounded retries on a persistent server failure", () => {
    const result = runCleanup({
      answers: [{ status: "500", body: "<html>internal error</html>" }],
      args: ["--max-attempts", "3"],
    });

    assert.equal(result.code, 1);
    assertReportShape(result.report, {
      ok: false,
      classification: "retries-exhausted",
      deleteStatus: 500,
      verifyStatus: 500,
    });
    // Three bounded attempts per phase, each recorded as retryable.
    assert.equal(result.report.deletion.attempts.length, 3);
    assert.equal(result.report.verification.attempts.length, 3);
    for (const attempt of result.report.deletion.attempts) {
      assert.equal(attempt.retryable, true);
    }
    assert.match(result.report.diagnostic, /retry budget was exhausted/);
  });

  it("fails on a network failure and records the transport error", () => {
    const result = runCleanup({
      answers: [{ status: "000", body: "", exitCode: 7 }],
    });

    assert.equal(result.code, 1);
    assertReportShape(result.report, {
      ok: false,
      classification: "network-failure",
      deleteStatus: null,
      verifyStatus: null,
    });
    assert.equal(result.report.deletion.attempts[0].httpStatus, null);
    assert.equal(result.report.deletion.attempts[0].rawStatus, "000");
    assert.equal(result.report.deletion.attempts[0].retryable, true);
    assert.match(result.report.diagnostic, /no HTTP response/);
  });
});

describe("cleanup that must refuse before requesting anything", () => {
  const malformedNames = [
    "edge-1", // no attempt number
    "edge-", // no digits at all
    "edge-1-1-1", // not the workflow's identity
    "EDGE-1-1", // the API is case-sensitive; refuse rather than guess
    "edge-1-1;rm -rf /", // a shell fragment must never reach a path
    "edge-1-1/../other", // nor may a path fragment
    "edge-1-1*", // nor a pattern
    "production-worker", // not a disposable Worker at all
  ];

  it("rejects every name that is not a disposable identity", () => {
    for (const worker of malformedNames) {
      const result = runCleanup({ worker });

      assert.equal(result.code, 2, `expected refusal for ${worker}`);
      assert.equal(result.requests.length, 0, `no request for ${worker}`);
      assert.equal(result.reportExists, true, `evidence for ${worker}`);
      assertReportShape(result.report, {
        worker,
        ok: false,
        classification: "invalid-worker-name",
        deleteAttempted: false,
        verifyAttempted: false,
      });
      // The refusal names the expected shape; it must not repeat a name that
      // contains anything the shape hint does not already contain.
      if (!"edge-<run>-<attempt>".includes(worker)) {
        assert.equal(
          result.report.diagnostic.includes(worker),
          false,
          `the diagnostic echoed ${worker} into the evidence`,
        );
      }
    }
  });

  it("rejects a too-long name", () => {
    const result = runCleanup({
      worker: `edge-${"9".repeat(40)}-1`,
    });

    assert.equal(result.code, 2);
    assert.equal(result.requests.length, 0);
    assert.equal(result.report.classification, "invalid-worker-name");
  });

  it("rejects missing or unusable credentials", () => {
    const noToken = runCleanup({ env: { CLOUDFLARE_API_TOKEN: "" } });
    assert.equal(noToken.code, 2);
    assert.equal(noToken.requests.length, 0);
    assert.equal(noToken.report.classification, "invalid-credentials");
    assert.equal(
      noToken.report.diagnostic.includes(TOKEN),
      false,
      "the diagnostic never carries the credential",
    );

    const noAccount = runCleanup({ env: { CLOUDFLARE_ACCOUNT_ID: "" } });
    assert.equal(noAccount.code, 2);
    assert.equal(noAccount.requests.length, 0);
    assert.equal(noAccount.report.classification, "invalid-account");

    const oddAccount = runCleanup({
      env: { CLOUDFLARE_ACCOUNT_ID: "not-an-account" },
    });
    assert.equal(oddAccount.code, 2);
    assert.equal(oddAccount.requests.length, 0);
    assert.equal(oddAccount.report.classification, "invalid-account");
  });

  it("requires an artefact directory", () => {
    const root = makeTemporaryRoot();
    const missingOut = new Deno.Command("bash", {
      args: [cleanupScript, "--worker", WORKER],
      env: {
        PATH: `${Deno.env.get("PATH") ?? ""}`,
        CLOUDFLARE_API_TOKEN: TOKEN,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      },
      stdout: "piped",
      stderr: "piped",
    }).outputSync();

    assert.equal(missingOut.code, 2);
    assert.match(
      new TextDecoder().decode(missingOut.stderr),
      /--out is required/,
    );
    assert.equal(existsSync(path.join(root, "artifacts")), false);
  });
});

describe("cleanup targets only the specified Worker", () => {
  it("addresses one resource and never enumerates anything", () => {
    const result = runCleanup({
      answers: [
        { status: "200", body: "" },
        { status: "404", body: ABSENT_BODY },
      ],
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.length, 2);

    const [deletion, verification] = result.requests;
    assert.equal(deletion.method, "DELETE");
    assert.equal(deletion.url, DELETE_URL);
    assert.equal(verification.method, "GET");
    assert.equal(verification.url, VERIFY_URL);

    for (const request of result.requests) {
      assert.equal(
        request.url.startsWith(
          `${API_BASE}/accounts/${ACCOUNT}/workers/scripts/${WORKER}`,
        ),
        true,
        `request escaped the target: ${request.url}`,
      );
      assert.equal(request.url.includes(OTHER_WORKER), false);
      assert.equal(request.url.includes("kv"), false);
      assert.equal(
        /\/workers\/scripts(\?|$)/.test(request.url),
        false,
        "the collection endpoint must never be called",
      );
      assert.equal(request.url.includes("*"), false);
    }

    // Exactly one deletion, for exactly one name.
    assert.equal(
      result.requests.filter((request) => request.method === "DELETE").length,
      1,
    );
    assert.equal(result.report.deletion.attempts.length, 1);
  });

  it("keeps the credential out of the argument vector and the evidence", () => {
    const result = runCleanup({
      answers: [
        { status: "200", body: "" },
        { status: "404", body: ABSENT_BODY },
      ],
    });

    assert.equal(result.code, 0, result.stderr);

    // curl receives the credential through --config, never as an argument...
    assert.equal(result.curlArgs.length, 2);
    for (const argv of result.curlArgs) {
      assert.equal(argv.includes(TOKEN), false, "the token reached curl argv");
      assert.match(argv, /--config /);
    }

    // ...and it appears in no output or artefact.
    for (
      const surface of [
        result.stdout,
        result.stderr,
        readFileSync(path.join(result.outDir, "cleanup.json"), "utf8"),
      ]
    ) {
      assert.equal(
        surface.includes(TOKEN),
        false,
        "the token reached an output",
      );
    }

    // The private curl config lived in a temporary directory that is removed.
    const leftovers = readdirSync(result.root, { withFileTypes: true })
      .filter((entry) =>
        entry.isDirectory() && entry.name.startsWith("edge-cleanup.")
      )
      .map((entry) => entry.name);
    assert.deepEqual(
      leftovers,
      [],
      "the temporary credential file was removed",
    );
  });
});
