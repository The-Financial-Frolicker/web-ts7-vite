import createWasmMath from "../build-wasm/wasm_math.js";

const wasm = await createWasmMath();

const result = wasm._add(19, 23);

console.log(`19 + 23 = ${result}`);

if (result !== 42) {
  throw new Error(`Unexpected result: ${result}`);
}
