/**
 * Runtime tests for the Cloudflare Worker handler in `./index.ts`.
 *
 * The handler is invoked directly with standard `Request` objects, so the tests
 * are deterministic and need no server, no network access and no bindings. Deno
 * executes the handler's TypeScript directly, so the test file needs no
 * transpilation step or Node runtime.
 *
 * The assertions describe the handler's current contract, which is the source
 * of truth for them: `worker/index.ts` routes on `URL.pathname` alone and
 * returns either the `/api/health` payload or a JSON 404 fallback.
 *
 * Deno's `Request` and `Response` are standards-compliant stand-ins rather than
 * workerd itself, so what is established here is the handler's routing and
 * payloads. Cloudflare-runtime details that a direct call cannot model - HEAD
 * body stripping, header normalisation, asset routing and the `run_worker_first`
 * patterns - are deliberately not asserted.
 */
import assert from "../scripts/lib/assert.mjs";
import { readFileSync } from "../scripts/lib/fs.mjs";
import { describe, it } from "../scripts/lib/test.mjs";

import worker from "./index.ts";

/**
 * Only the pathname matters, so any absolute origin works.
 */
const ORIGIN = "https://worker.test";

/**
 * The service identifier that project initialisation writes into the handler:
 * `deriveWorkerServiceName()` in `scripts/init-project.mjs` rewrites the
 * identity placeholder to `<package name>-worker`, and `package.json` gets the
 * same `<package name>`. Deriving the expected value keeps this test correct
 * both for the untouched template and for an initialised project, and keeps the
 * template's placeholder token out of a second file, where the initialiser's
 * straggler scan would reject it.
 */
const EXPECTED_SERVICE = `${
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).name
}-worker`;

/**
 * `new Date().toISOString()`: UTC, millisecond precision, `Z` suffix.
 */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Invoke the handler the way the runtime does, without starting one.
 *
 * The handler takes an `Env` but reads none of it (it is `_env` and
 * `wrangler.jsonc` declares no bindings), so an empty environment is enough.
 */
async function callWorker(path, init) {
  return await worker.fetch(new Request(new URL(path, ORIGIN), init), {});
}

/**
 * The media type of a response, without parameters such as `charset`.
 */
function mediaType(response) {
  return response.headers.get("content-type")?.split(";")[0].trim();
}

/**
 * Assert the response status and JSON content type, then return the body.
 */
async function expectJson(response, status) {
  assert.equal(response.status, status, "HTTP status");
  assert.equal(mediaType(response), "application/json", "content type");
  return await response.json();
}

describe("Worker default export", () => {
  it("exposes a fetch handler", () => {
    assert.equal(typeof worker.fetch, "function");
  });

  it("answers a request with no environment bindings", async () => {
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/health`),
      {},
    );

    assert.equal(response.status, 200);
  });
});

describe("GET /api/health", () => {
  it("returns 200 JSON with the health payload", async () => {
    const body = await expectJson(await callWorker("/api/health"), 200);

    const { timestamp, ...status } = body;

    assert.deepEqual(status, {
      status: "ok",
      service: EXPECTED_SERVICE,
      runtime: "cloudflare-workers",
    });
    assert.equal(typeof timestamp, "string");
  });

  it("returns exactly the four documented fields", async () => {
    const body = await (await callWorker("/api/health")).json();

    assert.deepEqual(
      Object.keys(body).sort(),
      ["runtime", "service", "status", "timestamp"],
    );
  });

  it("stamps an ISO-8601 UTC timestamp taken during the request", async () => {
    const before = Date.now();
    const response = await callWorker("/api/health");
    const after = Date.now();

    const { timestamp } = await response.json();

    assert.match(timestamp, ISO_8601_UTC);
    assert.equal(
      new Date(timestamp).toISOString(),
      timestamp,
      "timestamp round-trips through Date",
    );

    const stampedAt = Date.parse(timestamp);
    // Inclusive comparisons are deliberate: a stamp taken in the same
    // millisecond as either boundary is valid and is in fact the common case,
    // so `>` / `<` here would fail most runs.
    assert.ok(
      stampedAt >= before,
      `timestamp ${timestamp} predates the request start ${before}`,
    );
    assert.ok(
      stampedAt <= after,
      `timestamp ${timestamp} postdates the request end ${after}`,
    );
  });

  it("routes on the pathname only, so any origin and query work", async () => {
    const response = await worker.fetch(
      new Request("http://localhost:8787/api/health?verbose=1"),
      {},
    );
    const body = await expectJson(response, 200);

    assert.equal(body.status, "ok");
  });

  it("does not reject methods other than GET", async () => {
    // The handler is method-agnostic: it never inspects `request.method`.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const body = await expectJson(
        await callWorker("/api/health", { method }),
        200,
      );

      assert.equal(body.status, "ok", method);
    }
  });

  it("answers HEAD with the same status and content type", async () => {
    // No body assertion: direct invocation bypasses the runtime's HTTP layer,
    // which is what strips the body from a HEAD response in production.
    const response = await callWorker("/api/health", { method: "HEAD" });

    assert.equal(response.status, 200);
    assert.equal(mediaType(response), "application/json");
  });
});

describe("unknown routes", () => {
  it("returns a 404 JSON body naming the unmatched path", async () => {
    const body = await expectJson(await callWorker("/api/unknown"), 404);

    assert.deepEqual(body, { status: "not_found", path: "/api/unknown" });
  });

  it("echoes the pathname only, dropping the query string", async () => {
    const body = await expectJson(
      await callWorker("/api/missing?a=1&b=2"),
      404,
    );

    assert.deepEqual(body, { status: "not_found", path: "/api/missing" });
  });

  it("compares the path exactly: slash, case and encoding are significant", async () => {
    for (
      const path of [
        "/api/health/",
        "/API/Health",
        "/api/%68ealth",
        "/api//health",
      ]
    ) {
      const body = await expectJson(await callWorker(path), 404);

      assert.deepEqual(body, { status: "not_found", path }, path);
    }
  });

  it("returns the same 404 for any HTTP method", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const body = await expectJson(
        await callWorker("/api/unknown", { method }),
        404,
      );

      assert.deepEqual(
        body,
        { status: "not_found", path: "/api/unknown" },
        method,
      );
    }
  });

  it("falls back to 404 for non-API paths when invoked directly", async () => {
    // In the deployed configuration the static assets binding serves these
    // paths before the Worker runs (`run_worker_first: ["/api/*"]` in
    // wrangler.jsonc), so this documents the handler's own fallback only.
    for (const path of ["/", "/index.html", "/api"]) {
      const body = await expectJson(await callWorker(path), 404);

      assert.deepEqual(body, { status: "not_found", path }, path);
    }
  });
});
