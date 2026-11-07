/**
 * Child process: print the production build target that the installed Vite
 * resolves. Run with FFI scoped to Vite's native bindings, because importing
 * Vite loads Rolldown.
 */
const root = Deno.args[0] ?? Deno.cwd();

Deno.chdir(root);
const vite = await import("vite");
const resolved = await vite.resolveConfig({ configFile: false }, "build");

console.log(
  JSON.stringify({ version: vite.version, target: resolved.build.target }),
);
