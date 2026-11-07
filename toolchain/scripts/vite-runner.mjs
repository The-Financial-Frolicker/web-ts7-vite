/**
 * Toolchain-owned Vite runner: the single place that decides what Vite runs with.
 *
 * Modes:
 *
 *   build    production build of every environment
 *   server   development server (HMR, file watching, Worker runtime)
 *   preview  preview server serving the built output and running the Worker
 *
 * The ownership split is the point of this file. The application exports a
 * plain configuration object; the toolchain supplies `root`, disables the
 * application's configuration file, injects the Cloudflare plugin and discards
 * any `plugins` the application declares. The effective plugin list is therefore
 * identical in all three modes, which the acceptance tests assert.
 *
 * `inspectorPort: false` is toolchain policy: the plugin's Workers inspector
 * proxy otherwise binds a wildcard IPv6 listener on 9229, which a loopback
 * development profile must not grant.
 *
 * Both native bindings are used through Node-API. Deno must therefore be given
 * path-scoped `--allow-ffi` for their resolved real paths; the launcher does
 * that, not this file.
 *
 * Nothing here resolves, installs or updates a dependency.
 */

import {
  createBuilder,
  createServer,
  mergeConfig,
  preview,
} from "../node_modules/vite/dist/node/index.js";
import { cloudflare } from "../node_modules/@cloudflare/vite-plugin/dist/index.mjs";

/** Vite's development and preview listeners are loopback-only. */
export const DEFAULT_DEV_PORT = 5173;
export const DEFAULT_PREVIEW_PORT = 4173;

const MODES = Object.freeze(["build", "server", "preview"]);

function fail(message) {
  console.error(`vite-runner: ${message}`);
  Deno.exit(1);
}

/** The application-owned declarative configuration. */
async function readApplicationConfig(appRoot) {
  const url = new URL(`file://${appRoot}/vite.config.ts`);
  const module = await import(url.href);
  const config = module.default;
  if (config === null || typeof config !== "object") {
    fail(
      `${appRoot}/vite.config.ts must default-export a plain configuration object`,
    );
  }
  return config;
}

/** Port for a server mode, explicit and overridable by the acceptance tests. */
export function serverPort(mode, env = Deno.env) {
  const variable = mode === "preview" ? "VITE_PREVIEW_PORT" : "VITE_DEV_PORT";
  const fallback = mode === "preview" ? DEFAULT_PREVIEW_PORT : DEFAULT_DEV_PORT;
  const raw = env.get(variable);
  if (raw === undefined || raw === "") return fallback;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${variable} must be a TCP port, received ${JSON.stringify(raw)}`);
  }
  return port;
}

/** Effective configuration: toolchain policy with application values merged in. */
export function effectiveConfig(applicationConfig, appRoot, mode, env) {
  const toolchainDefaults = {
    root: appRoot,
    configFile: false,
    plugins: [
      cloudflare({
        viteEnvironment: { name: "worker" },
        inspectorPort: false,
      }),
    ],
  };

  if (mode !== "build") {
    const port = serverPort(mode, env);
    toolchainDefaults.server = { host: "127.0.0.1", port, strictPort: true };
    toolchainDefaults.preview = { host: "127.0.0.1", port, strictPort: true };
    // Vite's default cache lives in `<root>/node_modules/.vite`. Keeping it in
    // the application root instead means the optimiser never writes into the
    // toolchain dependency tree, and an application with no npm dependencies
    // needs no `node_modules` directory at all.
    toolchainDefaults.cacheDir = `${appRoot}/.vite`;
  }

  // `plugins` is a toolchain-owned integration point, so the application's value
  // is dropped rather than merged; everything else merges normally.
  const applicationValues = { ...applicationConfig };
  delete applicationValues.plugins;

  return mergeConfig(toolchainDefaults, applicationValues);
}

/** Stable, machine-readable evidence of the effective plugin policy. */
function reportPlugins(effective, mode, appRoot) {
  const names = (effective.plugins ?? [])
    .flat(Infinity)
    .filter(Boolean)
    .map((plugin) => plugin.name ?? "<unnamed>");

  console.log(
    `vite-runner: mode=${mode} root=${appRoot} pluginCount=${names.length}`,
  );
  console.log(
    `vite-runner: environments=${
      Object.keys(effective.environments ?? {}).join(",")
    }`,
  );
  console.log(`vite-runner: plugins=${names.join(",")}`);
}

/** Opt-in watcher trace, used only by the workflow acceptance test. */
function traceWatcher(server, env) {
  if (env.get("VITE_WATCH_TRACE") !== "1") return;
  const watcher = server?.watcher;
  if (!watcher || typeof watcher.on !== "function") {
    console.log("vite-runner: watch=trace-unavailable");
    return;
  }
  for (const event of ["add", "change", "unlink"]) {
    watcher.on(event, (path) => {
      console.log(`vite-runner: watch event=${event} path=${path}`);
    });
  }
  console.log("vite-runner: watch=trace-on");
}

/**
 * Graceful shutdown, registered before any plugin code runs.
 *
 * The Cloudflare plugin installs its own signal handling; a listener added after
 * it can lose the race to `process.exit`. Registering first and attaching the
 * server closer afterwards keeps the instrumented path observable.
 *
 * The instrumented lines are what the shutdown acceptance test asserts: a
 * terminated server reports the signal, attempts to close, and exits. Child
 * runtimes spawned by the plugin (workerd) are torn down with the parent; the
 * test checks for orphans independently.
 */
function installShutdown() {
  let close = null;
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    // Printed before any await. The plugin installs its own signal handling and
    // can terminate the process at any suspension point, so a marker written
    // after `await` is a race; this one is not.
    console.log(`vite-runner: shutdown signal=${signal} closing=1`);
    try {
      await close?.();
      console.log("vite-runner: shutdown closed=1");
    } catch (error) {
      console.log(`vite-runner: shutdown close-error=${error.message}`);
    }
    Deno.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    Deno.addSignalListener(signal, () => {
      shutdown(signal);
    });
  }

  return { setClose: (fn) => (close = fn) };
}

/** Build every environment (the Cloudflare plugin declares two). */
export async function buildApp(effective) {
  const builder = await createBuilder(effective);
  await builder.buildApp();
}

/** CLI entry point; returns a process exit code (servers never return). */
export async function main(argv = Deno.args, env = Deno.env, log = console) {
  const [mode, appArgument] = argv;

  if (!MODES.includes(mode)) {
    log.error(
      `vite-runner: mode must be one of ${MODES.join(", ")}, ` +
        `received ${JSON.stringify(mode)}`,
    );
    return 2;
  }
  if (typeof appArgument !== "string" || appArgument.length === 0) {
    log.error("vite-runner: an application root is required");
    return 2;
  }

  const appRoot = appArgument.replace(/\/$/, "");

  // Registered before any plugin code can install its own handler.
  const shutdown = installShutdown();

  try {
    const applicationConfig = await readApplicationConfig(appRoot);
    const effective = effectiveConfig(applicationConfig, appRoot, mode, env);
    reportPlugins(effective, mode, appRoot);

    if (mode === "build") {
      await buildApp(effective);
      return 0;
    }

    if (mode === "server") {
      const server = await createServer(effective);
      traceWatcher(server, env);
      await server.listen();
      console.log(
        `vite-runner: ready mode=server url=${
          server.resolvedUrls?.local?.[0] ?? ""
        }`,
      );
      shutdown.setClose(() => server.close());
      await new Promise(() => {});
    }

    const server = await preview(effective);
    traceWatcher(server, env);
    console.log(
      `vite-runner: ready mode=preview url=${
        server.resolvedUrls?.local?.[0] ?? ""
      }`,
    );
    shutdown.setClose(
      () =>
        new Promise((resolve) => {
          server.httpServer.close(() => resolve());
          resolve();
        }),
    );
    await new Promise(() => {});
  } catch (error) {
    log.error(`vite-runner: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
