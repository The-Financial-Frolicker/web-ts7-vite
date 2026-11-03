import assert from "./lib/assert.mjs";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";

import {
  checkDeployArtifacts,
  DeployArtifactError,
} from "./check-deploy-artifacts.mjs";

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

/** Set when the platform cannot create symbolic links. */
const symlinkSkip = (() => {
  const directory = makeTempDir("check-deploy-links-");

  try {
    symlinkSync("target", path.join(directory, "link"));
    return false;
  } catch {
    return "requires symbolic link support";
  }
})();

/**
 * A minimal browser-only glue fixture. The published glue must declare
 * `ENVIRONMENT_IS_WEB` (what `-sENVIRONMENT=web` emits), so every fixture that
 * stands in for it carries the marker.
 */
const BROWSER_GLUE = [
  "var ENVIRONMENT_IS_WEB = true;",
  "export default async () => ({});",
].join("\n") + "\n";

function baseConfig(name = "sample-app") {
  return {
    name,
    no_bundle: true,
    main: "index.js",
    compatibility_date: "2026-10-30",
    upload_source_maps: true,
    assets: {
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*"],
      directory: "../client",
    },
  };
}

/**
 * Create a deployment-artefact fixture. `config: null` omits the generated
 * Wrangler configuration; `configText` writes raw text instead of serialised
 * JSON; a `null` file value omits that file.
 */
function makeProject({
  name = "sample-app",
  config,
  configText,
  files = {},
} = {}) {
  const root = makeTempDir("check-deploy-");

  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name }, null, 2)}\n`,
  );

  const effectiveConfig = config === undefined ? baseConfig(name) : config;
  if (configText !== undefined || effectiveConfig !== null) {
    mkdirSync(path.join(root, "dist", "worker"), { recursive: true });
    writeFileSync(
      path.join(root, "dist", "worker", "wrangler.json"),
      configText ?? `${JSON.stringify(effectiveConfig, null, 2)}\n`,
    );
  }

  const defaults = {
    "dist/worker/index.js": "export default {};\n",
    "dist/worker/index.js.map": "{}\n",
    "dist/client/index.html": "<!doctype html>\n",
    "dist/client/wasm/wasm_math.js": BROWSER_GLUE,
    "dist/client/wasm/wasm_math.wasm": "wasm\n",
  };

  for (const [file, contents] of Object.entries({ ...defaults, ...files })) {
    if (contents === null) continue;

    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  return root;
}

function makeExternalFile(name, contents) {
  const directory = makeTempDir("check-deploy-external-");
  const file = path.join(directory, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function makeExternalAssets() {
  const directory = makeTempDir("check-deploy-external-assets-");

  for (
    const [file, contents] of Object.entries({
      "index.html": "<!doctype html>\n",
      "wasm/wasm_math.js": BROWSER_GLUE,
      "wasm/wasm_math.wasm": "wasm\n",
    })
  ) {
    const absolute = path.join(directory, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

  return directory;
}

function replaceWithSymlink(target, linkTarget) {
  rmSync(target, { recursive: true, force: true });
  const absoluteTarget = path.resolve(path.dirname(target), linkTarget);
  symlinkSync(
    linkTarget,
    target,
    statSync(absoluteTarget).isDirectory() ? "dir" : "file",
  );
}

function expectFailure(root, pattern) {
  assert.throws(
    () => checkDeployArtifacts(root),
    (error) => {
      assert.ok(
        error instanceof DeployArtifactError,
        `expected DeployArtifactError, got ${error}`,
      );
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe("checkDeployArtifacts", () => {
  it("accepts a consistent deployment artefact tree", () => {
    const root = makeProject();
    const result = checkDeployArtifacts(root);

    assert.equal(result.name, "sample-app");
    assert.equal(result.workerEntry, path.join(root, "dist/worker/index.js"));
    assert.equal(result.assetsDirectory, path.join(root, "dist/client"));
    assert.equal(result.binding, "ASSETS");
    assert.equal(result.notFoundHandling, "single-page-application");
  });

  it("accepts run_worker_first: true", () => {
    const config = baseConfig();
    config.assets.run_worker_first = true;

    assert.equal(
      checkDeployArtifacts(makeProject({ config })).name,
      "sample-app",
    );
  });

  it("rejects a Worker name that differs from package.json", () => {
    const config = baseConfig();
    config.name = "other-app";

    expectFailure(
      makeProject({ config }),
      /does not match package\.json name "sample-app"/,
    );
  });

  it("rejects a configuration that would re-bundle the Worker", () => {
    const config = baseConfig();
    config.no_bundle = false;

    expectFailure(makeProject({ config }), /"no_bundle": true/);
  });

  it("rejects a Worker entry point that leaves dist", () => {
    const config = baseConfig();
    config.main = "../../package.json";

    expectFailure(makeProject({ config }), /resolves outside dist\//);
  });

  it("rejects a missing Worker bundle", () => {
    expectFailure(
      makeProject({ files: { "dist/worker/index.js": null } }),
      /Worker bundle is missing/,
    );
  });

  it("rejects a missing source map when upload_source_maps is enabled", () => {
    expectFailure(
      makeProject({ files: { "dist/worker/index.js.map": null } }),
      /Worker source map is missing/,
    );
  });

  it("rejects a missing client entry point", () => {
    expectFailure(
      makeProject({ files: { "dist/client/index.html": null } }),
      /client index\.html is missing/,
    );
  });

  it("rejects a missing published WASM artefact", () => {
    expectFailure(
      makeProject({ files: { "dist/client/wasm/wasm_math.wasm": null } }),
      /published WASM binary is missing/,
    );
  });

  it("rejects an assets directory that leaves dist", () => {
    const config = baseConfig();
    config.assets.directory = "../../public";

    expectFailure(makeProject({ config }), /resolves outside dist\//);
  });

  it("rejects asset routing that was dropped by the build", () => {
    const config = baseConfig();
    config.assets.run_worker_first = [];

    expectFailure(makeProject({ config }), /run_worker_first/);
  });

  it("rejects a missing SPA fallback", () => {
    const config = baseConfig();
    config.assets.not_found_handling = "";

    expectFailure(makeProject({ config }), /not_found_handling/);
  });

  it("rejects an invalid compatibility date", () => {
    const config = baseConfig();
    config.compatibility_date = "30-10-2026";

    expectFailure(makeProject({ config }), /YYYY-MM-DD/);
  });

  it("rejects a missing generated Wrangler configuration", () => {
    expectFailure(
      makeProject({ config: null }),
      /generated Wrangler configuration/,
    );
  });

  it("rejects a project without a package name", () => {
    expectFailure(makeProject({ name: "" }), /package\.json "name"/);
  });
});

describe("symlink containment", () => {
  it(
    "accepts a Worker bundle symlinked inside dist",
    { skip: symlinkSkip },
    () => {
      const root = makeProject({
        files: {
          "dist/worker/bundle.js": "export default {};\n",
          "dist/worker/bundle.js.map": "{}\n",
        },
      });
      const target = path.join(root, "dist/worker/index.js");
      replaceWithSymlink(target, "bundle.js");

      const result = checkDeployArtifacts(root);
      assert.equal(result.workerEntry, target);
    },
  );

  it(
    "accepts an assets directory symlinked inside dist",
    { skip: symlinkSkip },
    () => {
      const root = makeProject();
      const client = path.join(root, "dist/client");
      rmSync(client, { recursive: true, force: true });

      const internal = path.join(root, "dist/assets");
      for (
        const [file, contents] of Object.entries({
          "index.html": "<!doctype html>\n",
          "wasm/wasm_math.js": BROWSER_GLUE,
          "wasm/wasm_math.wasm": "wasm\n",
        })
      ) {
        const absolute = path.join(internal, file);
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, contents);
      }
      symlinkSync("assets", client, "dir");

      const result = checkDeployArtifacts(root);
      assert.equal(result.assetsDirectory, client);
    },
  );

  it(
    "rejects a Worker bundle symlinked outside dist",
    { skip: symlinkSkip },
    () => {
      const external = makeExternalFile("index.js", "external bundle\n");
      const root = makeProject({
        files: { "dist/worker/index.js": null },
      });
      symlinkSync(
        external,
        path.join(root, "dist/worker/index.js"),
        "file",
      );

      expectFailure(
        root,
        /Worker bundle resolves outside the real dist\/ tree through a symbolic link/,
      );
    },
  );

  it(
    "rejects an assets directory symlinked outside dist",
    { skip: symlinkSkip },
    () => {
      const root = makeProject();
      replaceWithSymlink(
        path.join(root, "dist/client"),
        makeExternalAssets(),
      );

      expectFailure(
        root,
        /client assets directory resolves outside the real dist\/ tree through a symbolic link/,
      );
    },
  );

  it(
    "rejects a published WASM file symlinked outside dist",
    { skip: symlinkSkip },
    () => {
      const external = makeExternalFile("wasm_math.wasm", "wasm\n");
      const root = makeProject({
        files: { "dist/client/wasm/wasm_math.wasm": null },
      });
      symlinkSync(
        external,
        path.join(root, "dist/client/wasm/wasm_math.wasm"),
        "file",
      );

      expectFailure(
        root,
        /published WASM binary resolves outside the real dist\/ tree through a symbolic link/,
      );
    },
  );

  it(
    "rejects a generated config symlinked outside dist",
    { skip: symlinkSkip },
    () => {
      const external = makeExternalFile(
        "wrangler.json",
        `${JSON.stringify(baseConfig(), null, 2)}\n`,
      );
      const root = makeProject({ config: null });
      symlinkSync(
        external,
        path.join(root, "dist/worker/wrangler.json"),
        "file",
      );

      expectFailure(
        root,
        /generated Wrangler configuration resolves outside the real dist\/ tree through a symbolic link/,
      );
    },
  );

  it(
    "rejects a Worker directory symlinked outside dist",
    { skip: symlinkSkip },
    () => {
      const external = makeTempDir("check-deploy-external-worker-");
      writeFileSync(
        path.join(external, "wrangler.json"),
        `${JSON.stringify(baseConfig(), null, 2)}\n`,
      );
      writeFileSync(path.join(external, "index.js"), "external bundle\n");
      writeFileSync(path.join(external, "index.js.map"), "{}\n");

      const root = makeProject();
      replaceWithSymlink(path.join(root, "dist/worker"), external);

      expectFailure(
        root,
        /generated Wrangler configuration resolves outside the real dist\/ tree through a symbolic link/,
      );
    },
  );

  it(
    "rejects a broken symlink",
    { skip: symlinkSkip },
    () => {
      const root = makeProject({
        files: { "dist/client/index.html": null },
      });
      symlinkSync(
        "missing.html",
        path.join(root, "dist/client/index.html"),
        "file",
      );

      expectFailure(
        root,
        /client index\.html is missing or cannot be resolved/,
      );
    },
  );
});

describe("generated configuration parsing", () => {
  it("preserves // and /* */ inside JSON strings", () => {
    const config = baseConfig();
    config.description = "https://example.com // not a comment /* nor this */";

    assert.equal(
      checkDeployArtifacts(makeProject({ config })).name,
      "sample-app",
    );
  });

  it("preserves escaped quotation marks in JSON strings", () => {
    const config = baseConfig();
    config.description = 'the "name": "fake" field is just text';

    assert.equal(
      checkDeployArtifacts(makeProject({ config })).name,
      "sample-app",
    );
  });

  it("rejects comments in the generated configuration", () => {
    const json = `${JSON.stringify(baseConfig(), null, 2)}\n`;

    expectFailure(
      makeProject({
        configText: json.replace(
          '"sample-app",',
          '"sample-app",\n  // line comment',
        ),
      }),
      /Cannot parse generated Wrangler configuration/,
    );
    expectFailure(
      makeProject({
        configText: json.replace(
          '"sample-app",',
          '"sample-app",\n  /* block\n     comment */',
        ),
      }),
      /Cannot parse generated Wrangler configuration/,
    );
  });

  it("rejects trailing commas in the generated configuration", () => {
    const json = `${JSON.stringify(baseConfig(), null, 2)}\n`;

    expectFailure(
      makeProject({
        configText: json.replace(
          '"directory": "../client"',
          '"directory": "../client",',
        ),
      }),
      /Cannot parse generated Wrangler configuration/,
    );
  });
});

describe("Node dependency boundary", () => {
  /**
   * A fixture with the shape of the real browser-only glue: the web marker, the
   * read-only version probe Emscripten always emits, and the dead
   * `ENVIRONMENT_IS_NODE` assertion text the web-only build retains.
   */
  const WEB_ONLY_GLUE = [
    "if (typeof process !== 'undefined' && !process.versions?.bun) {",
    "  var probe = process.versions?.node;",
    "}",
    "var ENVIRONMENT_IS_WEB = !!globalThis.window;",
    "assert(!ENVIRONMENT_IS_NODE, 'node environment detected');",
    "export default async () => ({});",
  ].join("\n");

  const CLIENT_BUNDLE = "dist/client/assets/index-abc.js";

  it("accepts Node-free bundles and reports what it inspected", () => {
    const result = checkDeployArtifacts(
      makeProject({ files: { [CLIENT_BUNDLE]: "export const a = 1;\n" } }),
    );

    assert.deepEqual(result.compatibilityFlags, []);
    assert.deepEqual(result.nodeBoundary, {
      clientBundles: 1,
      wasmGlue: { environment: "ENVIRONMENT_IS_WEB", processProbes: 0 },
    });
  });

  it("accepts browser-only glue and reports the browser marker", () => {
    const result = checkDeployArtifacts(
      makeProject({
        files: { "dist/client/wasm/wasm_math.js": WEB_ONLY_GLUE },
      }),
    );

    assert.deepEqual(result.nodeBoundary.wasmGlue, {
      environment: "ENVIRONMENT_IS_WEB",
      processProbes: 2,
    });
  });

  it("accepts dead ENVIRONMENT_IS_NODE text in browser-only glue", () => {
    // The web-only build keeps that identifier in its assertion text; asserting
    // its absence would reject a correct artefact.
    assert.match(WEB_ONLY_GLUE, /ENVIRONMENT_IS_NODE/);
    assert.equal(
      checkDeployArtifacts(
        makeProject({
          files: { "dist/client/wasm/wasm_math.js": WEB_ONLY_GLUE },
        }),
      ).name,
      "sample-app",
    );
  });

  it("rejects a Worker bundle that imports a Node built-in", () => {
    expectFailure(
      makeProject({
        files: { "dist/worker/index.js": 'import fs from "node:fs";\n' },
      }),
      /Worker bundle must not depend on Node\.js: found a Node built-in/,
    );
  });

  it("rejects a client bundle that calls require()", () => {
    expectFailure(
      makeProject({ files: { [CLIENT_BUNDLE]: 'require("fs");\n' } }),
      /client bundle assets\/index-abc\.js must not depend on Node\.js: found a CommonJS require/s,
    );
  });

  it("rejects a client bundle that reads process.env", () => {
    expectFailure(
      makeProject({
        files: { [CLIENT_BUNDLE]: "const env = process.env.NODE_ENV;\n" },
      }),
      /found the Node process global/,
    );
  });

  it("rejects process reached through a global object", () => {
    for (const access of ["globalThis", "window", "self"]) {
      expectFailure(
        makeProject({
          files: { [CLIENT_BUNDLE]: `const v = ${access}.process.env.HOME;\n` },
        }),
        /found the Node process global reached through a global object/,
      );
    }
  });

  it("accepts a property that merely shares a Node global's name", () => {
    assert.equal(
      checkDeployArtifacts(
        makeProject({
          files: { [CLIENT_BUNDLE]: "const v = logger.process.value;\n" },
        }),
      ).name,
      "sample-app",
    );
  });

  it("rejects a cloudflare:node capability reference", () => {
    expectFailure(
      makeProject({
        files: {
          "dist/worker/index.js":
            'import { httpServerHandler } from "cloudflare:node";\n',
        },
      }),
      /Worker bundle must not depend on Node\.js: found a cloudflare:node capability reference/,
    );

    expectFailure(
      makeProject({
        files: { [CLIENT_BUNDLE]: 'import x from "cloudflare:node";\n' },
      }),
      /found a cloudflare:node capability reference/,
    );
  });

  it("accepts the glue's global-object version probe", () => {
    // Regression for the S4 glue rule: Emscripten's environment detection reads
    // `globalThis.process?.versions` even in browser-only output, which the
    // generic member rule would otherwise reject.
    const glue = [
      "var ENVIRONMENT_IS_WEB = !!globalThis.window;",
      "var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && ",
      "  globalThis.process?.type != 'renderer';",
      "export default async () => ({});",
    ].join("\n");

    assert.equal(
      checkDeployArtifacts(
        makeProject({ files: { "dist/client/wasm/wasm_math.js": glue } }),
      ).name,
      "sample-app",
    );
  });

  it("ignores source maps, which are never executed", () => {
    assert.equal(
      checkDeployArtifacts(
        makeProject({
          files: {
            [`${CLIENT_BUNDLE}.map`]: '{"sources":["node:fs"]}\n',
            "dist/worker/index.js.map":
              '{"sources":["require(\\"node:fs\\")"]}\n',
          },
        }),
      ).name,
      "sample-app",
    );
  });

  it("rejects a static node: import in the WASM glue", () => {
    const glue = [WEB_ONLY_GLUE, 'import fs from "node:fs";'].join("\n");

    expectFailure(
      makeProject({ files: { "dist/client/wasm/wasm_math.js": glue } }),
      /published WASM glue must not depend on Node\.js: found a Node built-in module specifier "node:fs"/,
    );
  });

  it("rejects a dynamically imported node: specifier in the WASM glue", () => {
    const glue = [
      WEB_ONLY_GLUE,
      'await import("node:worker_threads");',
    ].join("\n");

    expectFailure(
      makeProject({ files: { "dist/client/wasm/wasm_math.js": glue } }),
      /found a Node built-in module specifier "node:worker_threads"/,
    );
  });

  it("rejects a require() loading path in the WASM glue", () => {
    const glue = [WEB_ONLY_GLUE, 'require("node:fs");'].join("\n");

    expectFailure(
      makeProject({ files: { "dist/client/wasm/wasm_math.js": glue } }),
      /published WASM glue must not depend on Node\.js: found a CommonJS require\(\) call/,
    );
  });

  it("rejects a Node capability reached through process in the glue", () => {
    const glue = [WEB_ONLY_GLUE, "var home = process.env.HOME;"].join("\n");

    expectFailure(
      makeProject({ files: { "dist/client/wasm/wasm_math.js": glue } }),
      /Only Emscripten's read-only probes are accepted/,
    );
  });

  it("rejects a Node Buffer use in the WASM glue", () => {
    const glue = [WEB_ONLY_GLUE, 'var b = Buffer.from("x");'].join("\n");

    expectFailure(
      makeProject({ files: { "dist/client/wasm/wasm_math.js": glue } }),
      /found the Node Buffer global/,
    );
  });

  it("rejects glue that does not declare the browser environment", () => {
    // This is the shape of the previous `-sENVIRONMENT=web,node` artefact and of
    // any glue built for a non-browser environment.
    const glue = "export default async () => ({});\n";

    expectFailure(
      makeProject({ files: { "dist/client/wasm/wasm_math.js": glue } }),
      /is not browser-only: it does not declare ENVIRONMENT_IS_WEB/,
    );
  });

  it("rejects Node.js compatibility in the generated configuration", () => {
    const config = baseConfig();
    config.compatibility_flags = ["nodejs_compat"];

    expectFailure(
      makeProject({ config }),
      /"nodejs_compat", which opts the Worker into Node\.js compatibility/,
    );
  });

  it("rejects every Node.js compatibility variant, not just the bare name", () => {
    for (
      const flag of [
        "nodejs_compat_v2",
        "nodejs_compat_populate_process_env",
        "nodejs_als",
      ]
    ) {
      const config = baseConfig();
      config.compatibility_flags = [flag];

      expectFailure(
        makeProject({ config }),
        /which opts the Worker into Node\.js compatibility/,
      );
    }
  });

  it("accepts an explicit empty compatibility_flags array", () => {
    const config = baseConfig();
    config.compatibility_flags = [];

    assert.deepEqual(
      checkDeployArtifacts(makeProject({ config })).compatibilityFlags,
      [],
    );
  });

  it("rejects a non-array compatibility_flags value", () => {
    const config = baseConfig();
    config.compatibility_flags = "nodejs_compat";

    expectFailure(
      makeProject({ config }),
      /generated "compatibility_flags" must be an array/,
    );
  });
});
