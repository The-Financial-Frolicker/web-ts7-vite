/**
 * Reproducible fixtures for workerd capability probes.
 *
 * The probe is a real Worker served by the real workerd binary, configured with
 * the project's compatibility date and flags. Every capability is evaluated
 * inside that Worker, one at a time, so the result is a measurement rather than
 * an inference from a TypeScript `lib` declaration.
 *
 * Two rules shape the catalogue:
 *
 *   - Expressions use only syntax available in every workerd release the
 *     project could plausibly pin. A modern-only expression would make an old
 *     runtime fail to *parse* the fixture, which would look like every
 *     capability failing at once instead of one honest result.
 *   - An edition entry is representative, not exhaustive. The contract records
 *     the individual capability results; the edition label is derived from them
 *     and never claims to be an exact description of the runtime.
 */

/** Ordered from oldest to newest; index order drives edition derivation. */
export const EDITIONS = Object.freeze([
  "es2015",
  "es2016",
  "es2017",
  "es2018",
  "es2019",
  "es2020",
  "es2021",
  "es2022",
  "es2023",
  "es2024",
  "es2025",
]);

/**
 * Edition-defining capabilities. One entry per edition keeps the derivation
 * conservative: an edition is only claimed when every edition up to it is
 * supported.
 */
export const EDITION_CAPABILITIES = Object.freeze([
  {
    id: "es2015.core",
    edition: "es2015",
    expression:
      'typeof Promise === "function" && typeof Symbol.iterator === "symbol" && typeof Map === "function"',
  },
  {
    id: "es2016.array.includes",
    edition: "es2016",
    expression: "[1].includes(1) === true",
  },
  {
    id: "es2017.object.entries",
    edition: "es2017",
    expression:
      'Object.entries({ a: 1 }).length === 1 && typeof Object.values === "function"',
  },
  {
    id: "es2018.promise.finally",
    edition: "es2018",
    expression: 'typeof Promise.resolve(1).finally === "function"',
  },
  {
    id: "es2019.object.fromEntries",
    edition: "es2019",
    expression: 'Object.fromEntries([["a", 1]]).a === 1',
  },
  {
    id: "es2020.bigint",
    edition: "es2020",
    expression:
      'typeof BigInt === "function" && BigInt(1) === BigInt("1") && typeof globalThis === "object"',
  },
  {
    id: "es2021.promise.any",
    edition: "es2021",
    expression:
      'typeof Promise.any === "function" && "aa".replaceAll("a", "b") === "bb"',
  },
  {
    id: "es2022.object.hasOwn",
    edition: "es2022",
    expression:
      'typeof Object.hasOwn === "function" && typeof [].at === "function"',
  },
  {
    id: "es2023.array.toSorted",
    edition: "es2023",
    expression:
      'typeof [].toSorted === "function" && typeof [].findLast === "function"',
  },
  {
    id: "es2024.object.groupBy",
    edition: "es2024",
    expression:
      'typeof Object.groupBy === "function" && typeof Promise.withResolvers === "function"',
  },
  {
    id: "es2025.set.union",
    edition: "es2025",
    expression:
      'typeof Set.prototype.union === "function" && typeof Promise.try === "function"',
  },
]);

/**
 * Runtime capabilities that are not edition-shaped but matter to a Worker.
 * They are recorded individually so a change is visible without re-deriving an
 * edition.
 */
export const RUNTIME_CAPABILITIES = Object.freeze([
  {
    id: "runtime.webcrypto",
    expression:
      'typeof crypto === "object" && typeof crypto.subtle === "object" && typeof crypto.subtle.digest === "function"',
  },
  {
    id: "runtime.response.json",
    expression: 'typeof Response.json === "function"',
  },
  {
    id: "runtime.streams",
    expression:
      'typeof ReadableStream === "function" && typeof TransformStream === "function" && typeof WritableStream === "function"',
  },
  {
    id: "runtime.text.streams",
    expression:
      'typeof TextDecoderStream === "function" && typeof TextEncoderStream === "function"',
  },
  {
    id: "runtime.structuredClone",
    expression: 'typeof structuredClone === "function"',
  },
  {
    id: "runtime.abortsignal.timeout",
    expression:
      'typeof AbortSignal === "function" && typeof AbortSignal.timeout === "function"',
  },
  {
    id: "runtime.intl.segmenter",
    expression:
      'typeof Intl === "object" && typeof Intl.Segmenter === "function"',
  },
  {
    id: "runtime.webassembly",
    expression:
      'typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function"',
  },
]);

/** Every probe, in catalogue order. */
export function allCapabilities() {
  return [...EDITION_CAPABILITIES, ...RUNTIME_CAPABILITIES];
}

/** Capability ids belonging to one edition. */
export function capabilitiesForEdition(edition) {
  return EDITION_CAPABILITIES.filter((entry) => entry.edition === edition);
}

/**
 * Generate the probe Worker module.
 *
 * The module has no imports and evaluates each capability in its own `try`, so
 * one throwing expression cannot hide the results of the others.
 */
export function probeWorkerSource(capabilities = allCapabilities()) {
  const entries = capabilities
    .map(({ id, expression }) =>
      `  ${JSON.stringify(id)}: () => (${expression}),`
    )
    .join("\n");

  return `// Generated by scripts/contracts/fixtures.mjs. Do not edit.
const probes = {
${entries}
};

function evaluate(id) {
  try {
    return probes[id]() === true ? { ok: true } : { ok: false };
  } catch (error) {
    return { ok: false, error: String((error && error.name) || error) };
  }
}

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/probe") {
      return new Response("not found", { status: 404 });
    }

    const results = {};
    for (const id of Object.keys(probes)) {
      results[id] = evaluate(id);
    }

    return new Response(JSON.stringify({ results }), {
      headers: { "content-type": "application/json" },
    });
  },
};
`;
}

const SAFE_CONFIG_VALUE = /^[A-Za-z0-9_.:+-]+$/;

function configValue(value, label) {
  if (!SAFE_CONFIG_VALUE.test(value)) {
    throw new Error(
      `${label} contains characters this fixture cannot embed safely: ` +
        `${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Generate the workerd capnp configuration.
 *
 * `compatibilityDate` and `compatibilityFlags` are the project's own resolved
 * settings, so the probe measures the runtime the Worker will actually get.
 */
export function probeConfigSource({
  port,
  compatibilityDate,
  compatibilityFlags = [],
  moduleName = "probe-worker.mjs",
}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid probe port: ${port}`);
  }

  const flags = compatibilityFlags
    .map((flag) =>
      `            ${JSON.stringify(configValue(flag, "compatibility flag"))},`
    )
    .join("\n");

  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "probe",
      worker = (
        modules = [
          (
            name = ${JSON.stringify(moduleName)},
            esModule = embed ${JSON.stringify(moduleName)},
          ),
        ],
        compatibilityDate = ${
    JSON.stringify(configValue(compatibilityDate, "compatibility date"))
  },
        compatibilityFlags = [
${flags}
        ],
      ),
    ),
  ],
  sockets = [
    (
      name = "http",
      address = "127.0.0.1:${port}",
      http = (),
      service = "probe",
    ),
  ],
);
`;
}
