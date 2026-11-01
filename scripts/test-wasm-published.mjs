// Verifies the FINAL deployment artifact after Vite has built it.
// Node-based smoke test: instantiate the generated JS with its companion WASM
// binary and execute _add(19, 23) === 42 from dist/client/wasm.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

const jsPath = resolve("dist/client/wasm/wasm_math.js");
const wasmPath = resolve("dist/client/wasm/wasm_math.wasm");

for (const p of [jsPath, wasmPath]) {
  if (!existsSync(p) || statSync(p).size === 0) {
    throw new Error(`Missing/empty built artifact: ${p}\nRun the full build (scripts/build.sh) first.`);
  }
}

const { default: createWasmMath } = await import(pathToFileURL(jsPath).href);
const wasm = await createWasmMath();
const result = wasm._add(19, 23);
console.log("published dist/client 19 + 23 =", result);
if (result !== 42) throw new Error(`Published artifact produced wrong result: ${result}`);
