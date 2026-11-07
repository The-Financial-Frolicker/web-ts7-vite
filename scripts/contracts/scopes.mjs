/**
 * Contract scopes, component identity and the fingerprints derived from them.
 *
 * This module is deliberately dependency-free: it is the only contract code the
 * verifier shares with discovery, so a generated project can verify without
 * loading the exploratory machinery.
 *
 * Design rule (S9.4): component declarations are the *only* source of truth for
 * which inputs matter. `fingerprintInputs` is a projection over them, not a
 * second editable list, so "Emscripten is non-key for the web runtime" is
 * expressed once — as an empty `keyFor` — and cannot drift from the fingerprint.
 */

export const SCOPE_WORKERD_RUNTIME = "workerd-runtime";
export const SCOPE_VITE_TARGET = "vite-syntax-target";
export const SCOPE_TYPESCRIPT_LIBRARIES = "typescript-libraries";
export const SCOPE_LAUNCHER_PERMISSIONS = "launcher-permissions";

export const SCOPES = Object.freeze([
  SCOPE_WORKERD_RUNTIME,
  SCOPE_VITE_TARGET,
  SCOPE_TYPESCRIPT_LIBRARIES,
  SCOPE_LAUNCHER_PERMISSIONS,
]);

/**
 * Component identity and the scopes for which that identity is key evidence.
 *
 * `inputs(identity)` returns the fingerprint fields this component contributes.
 * A component with an empty `keyFor` is recorded as provenance but never hashed
 * into any compatibility fingerprint.
 *
 * Emscripten is non-key for every current scope: it produces the WASM module,
 * but it does not determine browser, Worker or WASM runtime compatibility. Its
 * identity still matters to build provenance (see `buildProvenanceDigest`), and
 * it would be key for a C++ compiler-capability contract if one existed.
 */
export const COMPONENTS = Object.freeze({
  platform: {
    keyFor: SCOPES,
    inputs: (identity) => ({ platform: identity.platform }),
  },
  workerd: {
    keyFor: [SCOPE_WORKERD_RUNTIME],
    inputs: (identity) => ({
      workerd: identity.workerd.version,
      compatibilityDate: identity.workerd.compatibilityDate,
      compatibilityFlags: identity.workerd.compatibilityFlags,
    }),
  },
  /**
   * The declared probe catalogue — the obligations, not the measurements.
   *
   * Without this input the catalogue could be weakened (a probe removed, or an
   * expression softened) in the same commit as a runtime change, and no
   * fingerprint would move. With it, any edit to what must be tested forces a
   * reviewed `contract:refresh`.
   *
   * A missing digest is an error rather than an omission: `canonicalJson` drops
   * `undefined`, so silently projecting nothing would yield a fingerprint over
   * four inputs instead of five.
   */
  capabilities: {
    keyFor: [SCOPE_WORKERD_RUNTIME],
    inputs: (identity) => {
      if (
        typeof identity.capabilities !== "string" ||
        identity.capabilities.length === 0
      ) {
        throw new Error(
          "the probe catalogue digest is missing from the identity",
        );
      }
      return { capabilities: identity.capabilities };
    },
  },
  vite: {
    keyFor: [SCOPE_VITE_TARGET],
    inputs: (identity) => ({
      vite: identity.vite.version,
      // The configured production target is part of the authorised source: an
      // override in vite.config.ts changes what the client bundle may use.
      buildTarget: identity.vite.buildTarget,
    }),
  },
  typescript: {
    keyFor: [SCOPE_TYPESCRIPT_LIBRARIES],
    inputs: (identity) => ({
      typescript: identity.typescript.version,
      // The declared `lib` lists are the authorised API surface of each
      // program, so they belong to the fingerprint of the libraries contract.
      clientLib: identity.typescript.clientLib,
      workerLib: identity.typescript.workerLib,
    }),
  },
  /**
   * Launcher permission profiles.
   *
   * The recorded requirement is what each launcher *declares* it needs, derived
   * from its own argument builder. What the execution environment actually
   * grants is a runtime matter: a `NotCapable` failure is a conformance or
   * execution failure and never widens this profile.
   */
  launchers: {
    keyFor: [SCOPE_LAUNCHER_PERMISSIONS],
    inputs: (identity) => ({ launchers: identity.launchers }),
  },
  emscripten: {
    // Non-key everywhere today; key only for a C++ compiler-capability contract.
    keyFor: Object.freeze([]),
    inputs: () => ({}),
  },
});

/** Components whose identity is key evidence for `scope`. */
export function componentsForScope(scope) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`unknown contract scope: ${scope}`);
  }

  return Object.entries(COMPONENTS)
    .filter(([, component]) => component.keyFor.includes(scope))
    .map(([name]) => name);
}

/**
 * Fingerprint inputs for a scope: the projection of the components that are key
 * for it. Field order is irrelevant because fingerprints are computed over the
 * canonical (key-sorted) serialisation.
 */
export function fingerprintInputs(scope, identity) {
  if (!SCOPES.includes(scope)) {
    throw new Error(`unknown contract scope: ${scope}`);
  }

  const inputs = {};
  for (const [name, component] of Object.entries(COMPONENTS)) {
    if (!component.keyFor.includes(scope)) continue;
    try {
      Object.assign(inputs, component.inputs(identity));
    } catch (error) {
      throw new Error(
        `component ${name} could not supply inputs for ${scope}: ${error.message}`,
      );
    }
  }

  return inputs;
}

/** The Emscripten fields that describe how a WASM artefact was produced. */
export const BUILD_PROVENANCE_FIELDS = Object.freeze([
  "sdkVersion",
  "emscriptenVersion",
  "clangVersion",
  "llvmRevision",
  "standardLibrary",
  "target",
]);

/**
 * Digest of the C++ build provenance.
 *
 * This is deliberately *not* a compatibility fingerprint: it records how the
 * artefact was made, so a compiler change is visible without implying that any
 * runtime contract changed. An unchanged runtime fingerprint is not evidence of
 * a reproducible build, and a changed compiler does not imply a broken runtime.
 */
export function buildProvenanceDigest(identity) {
  const emscripten = identity?.emscripten;
  if (emscripten === undefined) return null;

  const fields = {};
  for (const field of BUILD_PROVENANCE_FIELDS) {
    const entry = emscripten[field];
    fields[field] = entry !== null && typeof entry === "object" &&
        "value" in entry
      ? entry.value ?? null
      : entry ?? null;
  }

  return JSON.stringify(fields);
}
