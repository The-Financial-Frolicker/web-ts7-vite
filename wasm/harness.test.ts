/**
 * Build-tree smoke test for the Emscripten module, run on Deno.
 *
 * This replaces the former Node-based build-tree smoke test. It exercises
 * `build-wasm/wasm_math.*` with Node globals hidden and a browser-like
 * `window`, so it validates the same artefact under a Node-free runtime.
 */
import {
  assert,
  assertNodeGlobalsHidden,
  hideNodeGlobals,
  loadWasmMath,
  requireArtifact,
} from "./harness.ts";

const GLUE = new URL("../build-wasm/wasm_math.js", import.meta.url);
const WASM = new URL("../build-wasm/wasm_math.wasm", import.meta.url);

Deno.test("the harness runs with Node globals unavailable", () => {
  hideNodeGlobals();
  assertNodeGlobalsHidden();
});

Deno.test("a Node-dependent module fails under the harness profile", async () => {
  hideNodeGlobals();

  // Canary: proves the hidden profile is load-bearing. A module that reads a
  // Node global must fail here, otherwise "runs without Node" would be vacuous.
  const source = "export default () => process.env.HOME;";
  const module = await import(
    `data:text/javascript,${encodeURIComponent(source)}`
  );

  let failed = false;
  try {
    (module.default as () => unknown)();
  } catch {
    failed = true;
  }

  assert(failed, "a Node-dependent module must fail without Node globals");
});

Deno.test("build-tree glue loads through WebAssembly and computes 19 + 23", async () => {
  requireArtifact(GLUE, WASM);

  const wasm = await loadWasmMath(GLUE, WASM);

  assert(wasm._add(19, 23) === 42, "19 + 23 should be 42");
});
