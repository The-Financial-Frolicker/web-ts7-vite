/**
 * Execute the capability fixtures in the real workerd binary.
 *
 * Outcomes are deliberately three-valued:
 *
 *   supported    the runtime evaluated the capability successfully
 *   unsupported  the runtime evaluated it and reported it missing
 *   probe-failed the probe could not establish either fact (the runtime did not
 *                start, the request failed, the result was missing, or the
 *                expression threw)
 *
 * `probe-failed` is never folded into `unsupported`. A failed probe is recorded
 * with provenance `unverified`, which makes the contract unapprovable; an
 * unsupported capability is an honest measured fact that a human may accept.
 */

import {
  allCapabilities,
  probeConfigSource,
  probeWorkerSource,
} from "./fixtures.mjs";

export const PROBE_OUTCOMES = Object.freeze([
  "supported",
  "unsupported",
  "probe-failed",
]);

export class ProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeError";
  }
}

/** Resolve with the promise, or reject after `ms` with a labelled timeout. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ProbeError(`${label} timed out after ${ms} ms`)),
      ms,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Ask the OS for a free loopback port, then release it for workerd. */
function reserveLoopbackPort() {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr;
  listener.close();
  return port;
}

async function connectOnce(port, timeoutMs) {
  const connection = await withTimeout(
    Deno.connect({ hostname: "127.0.0.1", port }),
    timeoutMs,
    `connect to 127.0.0.1:${port}`,
  );

  try {
    const request = "GET /probe HTTP/1.1\r\n" +
      "Host: 127.0.0.1\r\n" +
      "Accept: application/json\r\n" +
      "Connection: close\r\n\r\n";
    await withTimeout(
      connection.write(new TextEncoder().encode(request)),
      timeoutMs,
      "write probe request",
    );

    const chunks = [];
    const buffer = new Uint8Array(65536);
    while (true) {
      const read = await withTimeout(
        connection.read(buffer),
        timeoutMs,
        "read probe response",
      );
      if (read === null) break;
      chunks.push(buffer.slice(0, read));
    }

    return new TextDecoder().decode(concat(chunks));
  } finally {
    try {
      connection.close();
    } catch {
      // Already closed.
    }
  }
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** Decode a minimal HTTP/1.1 response; chunked bodies are supported. */
export function parseHttpResponse(text) {
  const separator = text.indexOf("\r\n\r\n");
  if (separator === -1) {
    throw new ProbeError("probe response had no header terminator");
  }

  const head = text.slice(0, separator);
  let body = text.slice(separator + 4);
  const [statusLine, ...headerLines] = head.split("\r\n");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);

  if (!Number.isInteger(status)) {
    throw new ProbeError(
      `probe response had no status line: ${JSON.stringify(statusLine)}`,
    );
  }

  const headers = {};
  for (const line of headerLines) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1)
      .trim();
  }

  if (headers["transfer-encoding"]?.toLowerCase() === "chunked") {
    body = decodeChunked(body);
  }

  return { status, headers, body };
}

function decodeChunked(body) {
  let output = "";
  let index = 0;

  while (index < body.length) {
    const lineEnd = body.indexOf("\r\n", index);
    if (lineEnd === -1) break;
    const size = Number.parseInt(body.slice(index, lineEnd), 16);
    if (!Number.isFinite(size) || size === 0) break;
    const start = lineEnd + 2;
    output += body.slice(start, start + size);
    index = start + size + 2;
  }

  return output;
}

/** Map one raw probe result to its triple-valued outcome. */
export function mapProbeOutcome(raw) {
  if (raw === undefined || raw === null) {
    return {
      outcome: "probe-failed",
      detail: "no result reported by the runtime",
    };
  }
  if (raw.ok === true) {
    return { outcome: "supported", detail: "evaluated true" };
  }
  if (raw.ok !== false) {
    return {
      outcome: "probe-failed",
      detail: `malformed result: ${JSON.stringify(raw)}`,
    };
  }
  if (raw.error !== undefined) {
    return { outcome: "probe-failed", detail: `expression threw ${raw.error}` };
  }

  return { outcome: "unsupported", detail: "evaluated false" };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run every capability probe against `binary`.
 *
 * Returns one result per capability plus diagnostics. A runtime-level failure
 * marks every capability `probe-failed`; it never produces `unsupported`.
 */
export async function runCapabilityProbe({
  binary,
  workerdVersion,
  compatibilityDate,
  compatibilityFlags = [],
  timeoutMs = 25_000,
  tempRoot,
  io = console,
  capabilities = allCapabilities(),
}) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const diagnostics = [];
  const results = {};
  let failure;
  let child;
  let tempDir;
  let stdoutText;
  let stderrText;

  const runtimeLabel = workerdVersion === undefined
    ? "workerd"
    : `workerd ${workerdVersion}`;

  try {
    tempDir = Deno.makeTempDirSync({
      dir: tempRoot,
      prefix: "workerd-probe-",
    });
    Deno.writeTextFileSync(
      `${tempDir}/probe-worker.mjs`,
      probeWorkerSource(capabilities),
    );

    const port = reserveLoopbackPort();
    Deno.writeTextFileSync(
      `${tempDir}/probe.capnp`,
      probeConfigSource({ port, compatibilityDate, compatibilityFlags }),
    );

    io.log(
      `[probe] ${runtimeLabel}: compatibility date ${compatibilityDate}, ` +
        `flags [${compatibilityFlags.join(", ")}], loopback 127.0.0.1:${port}`,
    );

    child = new Deno.Command(binary, {
      args: ["serve", "probe.capnp"],
      cwd: tempDir,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    stdoutText = new Response(child.stdout).text();
    stderrText = new Response(child.stderr).text();

    let responseText;
    let lastError;
    while (responseText === undefined && Date.now() < deadline) {
      try {
        responseText = await connectOnce(
          port,
          Math.min(2000, remaining()),
        );
      } catch (error) {
        lastError = error;
        await delay(50);
      }
    }

    if (responseText === undefined) {
      throw new ProbeError(
        `${runtimeLabel} did not accept a probe connection within ` +
          `${timeoutMs} ms: ${
            lastError?.message ?? "no connection attempt completed"
          }`,
      );
    }

    const response = parseHttpResponse(responseText);
    if (response.status !== 200) {
      throw new ProbeError(
        `probe endpoint returned HTTP ${response.status}`,
      );
    }

    let payload;
    try {
      payload = JSON.parse(response.body);
    } catch (error) {
      throw new ProbeError(`probe response was not JSON: ${error.message}`);
    }

    const reported = payload?.results;
    if (reported === null || typeof reported !== "object") {
      throw new ProbeError("probe response did not contain a results object");
    }

    for (const { id } of capabilities) {
      results[id] = mapProbeOutcome(reported[id]);
    }

    io.log(
      `[probe] ${runtimeLabel}: ` +
        `${
          Object.values(results).filter((r) => r.outcome === "supported").length
        }` +
        `/${capabilities.length} capabilities supported`,
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    diagnostics.push(failure);
    for (const { id } of capabilities) {
      results[id] = {
        outcome: "probe-failed",
        detail: `runtime probe failed: ${failure}`,
      };
    }
    io.error(`[probe] ${runtimeLabel}: ${failure}`);
  } finally {
    if (child !== undefined) {
      try {
        child.kill("SIGKILL");
      } catch (error) {
        diagnostics.push(
          `could not signal the probe runtime: ${error.message}`,
        );
      }

      try {
        await withTimeout(child.status, 5000, "probe runtime exit");
      } catch (error) {
        diagnostics.push(`probe runtime did not exit: ${error.message}`);
      }

      // Output is only drained after the process is gone: awaiting a live
      // child's pipe would block teardown forever.
      const [stdout, stderr] = await withTimeout(
        Promise.all([
          stdoutText ?? Promise.resolve(""),
          stderrText ?? Promise.resolve(""),
        ]),
        1000,
        "probe runtime output",
      ).catch(() => ["", ""]);

      if (failure !== undefined && stderr.trim().length > 0) {
        diagnostics.push(
          `probe runtime stderr: ${
            stderr.trim().split("\n").slice(-3).join(" | ")
          }`,
        );
      }
      if (failure !== undefined && stdout.trim().length > 0) {
        diagnostics.push(
          `probe runtime stdout: ${
            stdout.trim().split("\n").slice(-3).join(" | ")
          }`,
        );
      }
    }

    if (tempDir !== undefined) {
      try {
        Deno.removeSync(tempDir, { recursive: true });
      } catch (error) {
        diagnostics.push(
          `probe fixture directory was not removed (${tempDir}): ${error.message}`,
        );
      }
    }
  }

  return {
    ok: failure === undefined,
    failure,
    results,
    diagnostics,
    evidence: `${runtimeLabel} executed the capability probe Worker over ` +
      `loopback with compatibility date ${compatibilityDate} and flags ` +
      `[${compatibilityFlags.join(", ")}]`,
  };
}
