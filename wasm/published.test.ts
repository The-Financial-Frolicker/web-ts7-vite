/**
 * Published-artefact smoke test for the Emscripten module, run on Deno.
 *
 * This replaces the former Node-based published-artefact smoke test. It
 * exercises what the build actually ships (`dist/client/wasm/`), so it must run
 * after a full build.
 */
import { assert, loadWasmMath, requireArtifact } from "./harness.ts";

const GLUE = new URL("../dist/client/wasm/wasm_math.js", import.meta.url);
const WASM = new URL("../dist/client/wasm/wasm_math.wasm", import.meta.url);

Deno.test("published glue loads through WebAssembly and computes 19 + 23", async () => {
  requireArtifact(GLUE, WASM);

  const wasm = await loadWasmMath(GLUE, WASM);

  assert(wasm._add(19, 23) === 42, "19 + 23 should be 42");
});
