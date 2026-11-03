/**
 * Deno-side harness for the Emscripten-generated WebAssembly module.
 *
 * The generated glue chooses its environment from `globalThis` at module
 * evaluation time. Deno defines `process`, `Buffer` and `global`, so the
 * harness removes them before the glue is imported and declares `window`
 * explicitly: that is the browser-*like* profile the glue expects. This proves
 * the module needs no Node runtime; it is not a real-browser test.
 *
 * Loading goes through `Module.instantiateWasm`, the loader hook the generated
 * glue supports, so the harness needs only `WebAssembly` and `Deno.readFile`.
 * It deliberately has no npm or JSR dependency.
 */

/**
 * Node globals that Deno exposes (or may start exposing) and that the glue must
 * not see. `process`, `Buffer` and `global` exist in Deno 2; the rest are
 * removed defensively so a future compat change cannot silently re-enable the
 * Node code path.
 */
const NODE_GLOBALS = [
  "process",
  "require",
  "module",
  "exports",
  "Buffer",
  "__dirname",
  "__filename",
  "global",
] as const;

/** The exported surface of the module under test. */
export type WasmMathModule = { _add(a: number, b: number): number };

/** The modularised Emscripten factory, as used by `src/main.ts`. */
export type WasmMathFactory = (options: {
  instantiateWasm(
    imports: WebAssembly.Imports,
    success: (instance: WebAssembly.Instance) => void,
  ): WebAssembly.Exports;
}) => Promise<WasmMathModule>;

/** Minimal assertion helper: the harness must not depend on a test library. */
export function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** Remove the Node runtime globals so the glue must take its browser path. */
export function hideNodeGlobals(): void {
  for (const name of NODE_GLOBALS) {
    Object.defineProperty(globalThis, name, {
      value: undefined,
      configurable: true,
    });
  }
}

/** Fail unless the Node profile really is unavailable. */
export function assertNodeGlobalsHidden(): void {
  const scope = globalThis as Record<string, unknown>;

  for (const name of NODE_GLOBALS) {
    assert(
      typeof scope[name] === "undefined",
      `Node global ${JSON.stringify(name)} is still defined`,
    );
  }
}

/**
 * Establish the browser-like environment: the glue computes
 * `ENVIRONMENT_IS_WEB` as exactly `!!globalThis.window`.
 */
export function browserLike(): void {
  (globalThis as { window?: unknown }).window = globalThis;
}

/** Fail with an actionable message when a build artefact is missing. */
export function requireArtifact(...files: URL[]): void {
  for (const file of files) {
    let size = 0;

    try {
      const stat = Deno.statSync(file);
      if (stat.isFile) size = stat.size;
    } catch {
      size = 0;
    }

    assert(
      size > 0,
      `missing or empty build artefact ${file.pathname}; ` +
        "run `deno task build` first",
    );
  }
}

/**
 * Load the glue with Node globals unavailable and return the instance.
 *
 * `instantiateWasm` receives the import object the glue constructed and a
 * success callback, and must return the instance exports.
 */
export async function loadWasmMath(
  glue: URL,
  wasm: URL,
): Promise<WasmMathModule> {
  hideNodeGlobals();
  assertNodeGlobalsHidden();
  browserLike();

  const bytes = await Deno.readFile(wasm);
  const factory = (await import(glue.href))
    .default as unknown as WasmMathFactory;

  return await factory({
    instantiateWasm(imports: WebAssembly.Imports, success) {
      const instance = new WebAssembly.Instance(
        new WebAssembly.Module(bytes),
        imports,
      );
      success(instance);
      return instance.exports;
    },
  });
}
