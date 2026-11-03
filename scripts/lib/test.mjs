/**
 * Tiny `describe`/`it`/`after` adapter over Deno's built-in test runner.
 *
 * It keeps the existing suites reviewable without importing Node's test module.
 * `after` callbacks run on Deno's `unload` event; tests that need per-test
 * cleanup still do it explicitly.
 */

const prefixes = [];
const cleanups = [];
let unloadRegistered = false;

function registerUnload() {
  if (unloadRegistered) return;
  unloadRegistered = true;

  globalThis.addEventListener("unload", () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        console.error("cleanup failed:", error);
      }
    }
  });
}

/** Group the following `it` registrations under a name prefix. */
export function describe(name, fn) {
  prefixes.push(name);
  try {
    fn();
  } finally {
    prefixes.pop();
  }
}

/** Register a Deno test, optionally skipped, under the current group. */
export function it(name, optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn ?? {};
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;

  Deno.test({
    name: [...prefixes, name].join(" > "),
    ignore: options.skip === undefined || options.skip === false
      ? false
      : String(options.skip),
    fn,
  });
}

/** Register a cleanup callback to run when the test process unloads. */
export function after(fn) {
  cleanups.push(fn);
  registerUnload();
}
