/**
 * Tests for the Deno-owned development and preview launcher.
 *
 * These assert the command lines the launcher actually builds, not strings in
 * its source: the profiles, the wildcard-bind exception, the absence of esbuild
 * process permission, and that every path-granted executable and binding is a
 * resolved real path.
 */

import assert from "./lib/assert.mjs";
import path from "./lib/path.mjs";
import { describe, it } from "./lib/test.mjs";
import {
  buildViteServerArgs,
  resolveViteServerInvocation,
  SERVER_PORTS,
  serverEnv,
  serverPort,
  serverStatePaths,
  VITE_SERVER_MODES,
} from "./vite-server.mjs";
import { buildViteArgs, resolveViteInvocation } from "./vite-build.mjs";

const projectRoot = Deno.cwd();
// The toolchain is installed outside the application tree; resolution uses it.
// The generator owns the mise-backed resolution view inside its own subroot.
const generatorInstallationRoot = path.join(
  projectRoot,
  "generator",
  "toolchain",
);

function fakeEnv(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get: (name) => map.get(name),
    toObject: () => Object.fromEntries(map),
  };
}

function value(flag, args) {
  return args.find((argument) => argument.startsWith(`${flag}=`))
    ?.slice(flag.length + 1);
}

describe("Deno-owned Vite server launcher", () => {
  it("exposes exactly the dev and preview modes with explicit ports", () => {
    assert.deepEqual([...VITE_SERVER_MODES], ["dev", "preview"]);
    assert.equal(SERVER_PORTS.dev, 5173);
    assert.equal(SERVER_PORTS.preview, 4173);
    assert.equal(serverPort("dev", fakeEnv()), 5173);
    assert.equal(serverPort("preview", fakeEnv()), 4173);
    assert.equal(serverPort("dev", fakeEnv({ VITE_DEV_PORT: "6001" })), 6001);
    assert.throws(
      () => serverPort("dev", fakeEnv({ VITE_DEV_PORT: "not-a-port" })),
      /VITE_DEV_PORT must be a TCP port/,
    );
    assert.throws(
      () => serverPort("build", fakeEnv()),
      /unknown Vite server mode/,
    );
  });

  it("keeps dev and preview profiles separate and port-specific", () => {
    const invocation = resolveViteServerInvocation(
      generatorInstallationRoot,
      projectRoot,
    );
    const dev = buildViteServerArgs(invocation, "dev", SERVER_PORTS.dev);
    const preview = buildViteServerArgs(
      invocation,
      "preview",
      SERVER_PORTS.preview,
    );

    assert.ok(
      JSON.stringify(dev) !== JSON.stringify(preview),
      "dev and preview must not share one command line",
    );
    assert.equal(dev.at(-2), "server");
    assert.equal(preview.at(-2), "preview");
    // The long-lived listener is loopback; the wildcard entry exists only for
    // Vite's port-availability probe, and is scoped to that one port.
    assert.equal(
      value("--allow-net", dev),
      "127.0.0.1,localhost,0.0.0.0:5173,[::]:5173",
    );
    assert.equal(
      value("--allow-net", preview),
      "127.0.0.1,localhost,0.0.0.0:4173,[::]:4173",
    );
  });

  it("grants only what the server needs", () => {
    const invocation = resolveViteServerInvocation(
      generatorInstallationRoot,
      projectRoot,
    );
    const args = buildViteServerArgs(invocation, "dev", SERVER_PORTS.dev);

    for (
      const required of [
        "--allow-read",
        "--allow-env",
        "--allow-sys",
        `--allow-write=${invocation.appRoot}`,
        `--allow-run=${invocation.workerd}`,
        `--allow-ffi=${invocation.rolldown}`,
        `--allow-ffi=${invocation.lightningcss}`,
        "--cached-only",
        "--no-lock",
      ]
    ) {
      assert.ok(args.includes(required), `missing ${required}: ${args}`);
    }

    // esbuild process permission was shown to be unnecessary for dev/preview.
    assert.equal(
      args.filter((argument) => argument.startsWith("--allow-run=")).length,
      1,
      `exactly one --allow-run=: ${args}`,
    );
    assert.ok(!args.includes("--allow-all"), "no broad permissions");
    assert.ok(!args.includes("--allow-write"), "writes are application-scoped");
    assert.ok(
      !args.some((argument) =>
        argument.startsWith("--allow-ffi=") &&
        argument.endsWith("/build")
      ),
      "no executable masquerades as a binding",
    );
  });

  it("grants every path-scoped permission on a resolved real path", () => {
    const invocation = resolveViteServerInvocation(
      generatorInstallationRoot,
      projectRoot,
    );
    const args = buildViteServerArgs(invocation, "dev", SERVER_PORTS.dev);

    for (const flag of ["--allow-run", "--allow-ffi", "--allow-write"]) {
      const granted = args
        .filter((argument) => argument.startsWith(`${flag}=`))
        .map((argument) => argument.slice(flag.length + 1));

      assert.ok(granted.length > 0, `no ${flag} grant: ${args}`);
      for (const path of granted) {
        assert.equal(Deno.realPathSync(path), path, `${path} is not canonical`);
        assert.ok(
          Deno.statSync(path).isFile || Deno.statSync(path).isDirectory,
          `${path} must exist`,
        );
      }
    }
  });

  it("redirects temporary, configuration and log state into the application", () => {
    const paths = serverStatePaths("/app");
    assert.equal(paths.tmp, "/app/.wrangler/tmp");
    assert.equal(paths.xdg, "/app/.wrangler/xdg");
    assert.equal(paths.logs, "/app/.wrangler/logs");

    const env = serverEnv(
      "/app",
      "preview",
      4173,
      fakeEnv({ HOME: "/home/dev" }),
    );
    assert.equal(env.TMPDIR, "/app/.wrangler/tmp");
    assert.equal(env.XDG_CONFIG_HOME, "/app/.wrangler/xdg");
    assert.equal(env.WRANGLER_LOG_PATH, "/app/.wrangler/logs");
    assert.equal(env.WRANGLER_SEND_METRICS, "false");
    assert.equal(env.VITE_PREVIEW_PORT, "4173");
  });

  it("shares one plugin policy with the build: same runner, different mode", () => {
    const vite = resolveViteInvocation(generatorInstallationRoot);
    const server = resolveViteServerInvocation(
      generatorInstallationRoot,
      projectRoot,
    );
    const build = buildViteArgs(vite, [], "local", projectRoot);
    const dev = buildViteServerArgs(server, "dev", SERVER_PORTS.dev);

    assert.equal(vite.runner, server.runner);
    assert.equal(build.at(-2), "build");
    assert.equal(dev.at(-2), "server");
    assert.equal(build.at(-1), dev.at(-1), "both run against the same root");
  });
});
