import assert from "./lib/assert.mjs";
import { run } from "./lib/command.mjs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";
import { resolveTsc } from "./tsc-check.mjs";
import { toolchainRoot } from "./lib/toolchain/runtime.mjs";

import {
  checkCapabilityBoundary,
  CONFIG_INVARIANTS,
  DENO_LOCK,
  findConfigInvariantViolations,
  findLockedNodeTypes,
  main,
  NodeBoundaryError,
  PACKAGE_JSON,
  REQUIRED_CONFIG_FILES,
  stripJsonComments,
  WORKER_TSCONFIG,
} from "./check-node-boundary.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

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

function writeFile(root, file, contents) {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

const CLEAN_PACKAGE_JSON = JSON.stringify(
  { name: "sample", private: true, devDependencies: { vite: "^8.0.0" } },
  null,
  2,
);

const CLEAN_CLIENT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: { lib: ["ES2023", "DOM"], types: ["vite/client"] },
    include: ["src"],
  },
  null,
  2,
);

const CLEAN_WORKER_TSCONFIG = JSON.stringify(
  { compilerOptions: { lib: ["ES2022"], types: [] }, include: ["./**/*.ts"] },
  null,
  2,
);

const CLEAN_WRANGLER = [
  "{",
  "  // JSONC comments are valid here and must not confuse the reader",
  '  "name": "sample",',
  '  "compatibility_date": "2026-10-30"',
  "}",
  "",
].join("\n");

const CLEAN_LOCK = JSON.stringify(
  {
    version: "5",
    specifiers: { "npm:vite@^8.0.0": "8.0.0" },
    npm: { "vite@8.0.0": {} },
    workspace: { packageJson: { dependencies: ["npm:vite@^8.0.0"] } },
  },
  null,
  2,
);

/** A minimal project that satisfies every configuration invariant. */
function makeProject(overrides = {}) {
  const root = makeTempDir("boundary-");
  const files = {
    [PACKAGE_JSON]: CLEAN_PACKAGE_JSON,
    "tsconfig.json": CLEAN_CLIENT_TSCONFIG,
    [WORKER_TSCONFIG]: CLEAN_WORKER_TSCONFIG,
    "wrangler.jsonc": CLEAN_WRANGLER,
    [DENO_LOCK]: CLEAN_LOCK,
    ...overrides,
  };

  for (const [file, contents] of Object.entries(files)) {
    if (contents === null) continue;
    writeFile(root, file, contents);
  }

  return root;
}

function messages(violations) {
  return violations.map((violation) => violation.message);
}

/** Assert that exactly one violation is reported and that it matches. */
function expectViolation(violations, pattern) {
  assert.equal(violations.length, 1, JSON.stringify(messages(violations)));
  assert.match(violations[0].message, pattern);
  return violations[0];
}

describe("stripJsonComments", () => {
  it("removes comments so JSONC parses", () => {
    const jsonc =
      '{\n  // comment\n  "a": 1, /* inline */\n  "b": "// kept"\n}\n';

    assert.deepEqual(JSON.parse(stripJsonComments(jsonc)), {
      a: 1,
      b: "// kept",
    });
  });

  it("keeps comment-like text inside strings, including escapes", () => {
    const jsonc = [
      "{",
      '  "url": "https://example.test/a//b",',
      '  "note": "escaped \\" then /* not a comment */",',
      "  // real comment",
      '  "last": true',
      "}",
      "",
    ].join("\n");

    assert.deepEqual(JSON.parse(stripJsonComments(jsonc)), {
      url: "https://example.test/a//b",
      note: 'escaped " then /* not a comment */',
      last: true,
    });
  });

  it("keeps adjacent tokens apart when a block comment separates them", () => {
    assert.equal(stripJsonComments("[1/*x*/2]"), "[1 2]");
  });
});

describe("findLockedNodeTypes", () => {
  it("finds @types/node however the lockfile records it", () => {
    const lock = {
      version: "5",
      specifiers: { "npm:@types/node@^22.0.0": "22.1.0" },
      npm: { "@types/node@22.1.0": { integrity: "sha512-x" } },
      workspace: { packageJson: { devDependencies: ["npm:@types/node@^22"] } },
    };

    assert.deepEqual(findLockedNodeTypes(lock), [
      "@types/node@22.1.0",
      "npm:@types/node@^22",
      "npm:@types/node@^22.0.0",
    ]);
  });

  it("does not confuse @types/node-fetch with @types/node", () => {
    const lock = { npm: { "@types/node-fetch@2.6.0": {} } };

    assert.deepEqual(findLockedNodeTypes(lock), []);
  });

  it("handles an unknown nested shape instead of assuming a schema", () => {
    const lock = { future: { packages: [{ id: "@types/node@24.0.0" }] } };

    assert.deepEqual(findLockedNodeTypes(lock), ["@types/node@24.0.0"]);
  });
});

describe("findConfigInvariantViolations", () => {
  it("accepts a project that satisfies every invariant", () => {
    assert.deepEqual(findConfigInvariantViolations(makeProject()), []);
    assert.equal(CONFIG_INVARIANTS.length, 6);
  });

  it("rejects @types/node in any package.json dependency section", () => {
    for (
      const section of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]
    ) {
      const root = makeProject({
        [PACKAGE_JSON]: JSON.stringify(
          { name: "sample", [section]: { "@types/node": "^22.0.0" } },
          null,
          2,
        ),
      });

      expectViolation(
        findConfigInvariantViolations(root),
        /must not depend on "@types\/node"/,
      );
    }
  });

  it("rejects @types/node pinned by deno.lock", () => {
    const root = makeProject({
      [DENO_LOCK]: JSON.stringify(
        {
          version: "5",
          npm: { "@types/node@22.1.0": { integrity: "sha512-x" } },
        },
        null,
        2,
      ),
    });

    const violation = expectViolation(
      findConfigInvariantViolations(root),
      /pins "@types\/node@22\.1\.0"/,
    );
    assert.equal(violation.file, DENO_LOCK);
  });

  it("rejects a client tsconfig without vite/client types", () => {
    const root = makeProject({
      "tsconfig.json": JSON.stringify(
        { compilerOptions: { lib: ["ES2023"], types: [] } },
        null,
        2,
      ),
    });

    expectViolation(
      findConfigInvariantViolations(root),
      /compilerOptions\.types must include "vite\/client"/,
    );
  });

  it("rejects an implicit types field, which would load every @types package", () => {
    const root = makeProject({
      "tsconfig.json": JSON.stringify(
        { compilerOptions: { lib: ["ES2023", "DOM"] } },
        null,
        2,
      ),
    });

    expectViolation(
      findConfigInvariantViolations(root),
      /compilerOptions\.types must be an explicit array/,
    );
  });

  it("rejects non-empty worker types", () => {
    const root = makeProject({
      [WORKER_TSCONFIG]: JSON.stringify(
        { compilerOptions: { lib: ["ES2022"], types: ["node"] } },
        null,
        2,
      ),
    });

    const violations = findConfigInvariantViolations(root);
    assert.ok(
      messages(violations).some((message) =>
        /compilerOptions\.types must be empty/.test(message)
      ),
      JSON.stringify(messages(violations)),
    );
    assert.ok(
      messages(violations).some((message) =>
        /must not include "node"/.test(message)
      ),
      JSON.stringify(messages(violations)),
    );
  });

  it("rejects a lib entry naming a Node library", () => {
    for (
      const file of ["tsconfig.json", WORKER_TSCONFIG]
    ) {
      const config = JSON.parse(
        file === "tsconfig.json"
          ? CLEAN_CLIENT_TSCONFIG
          : CLEAN_WORKER_TSCONFIG,
      );
      config.compilerOptions.lib = ["ES2023", "node"];

      expectViolation(
        findConfigInvariantViolations(
          makeProject({ [file]: JSON.stringify(config) }),
        ),
        /compilerOptions\.lib must not name a Node library/,
      );
    }
  });

  it("rejects nodejs_compat and its variants in wrangler.jsonc", () => {
    for (
      const flag of ["nodejs_compat", "nodejs_compat_v2", "nodejs_als"]
    ) {
      const root = makeProject({
        "wrangler.jsonc": [
          "{",
          '  "name": "sample",',
          `  "compatibility_flags": ["${flag}"]`,
          "}",
          "",
        ].join("\n"),
      });

      expectViolation(
        findConfigInvariantViolations(root),
        new RegExp(`must not enable "${flag}"`),
      );
    }
  });

  it("fails closed when a configuration file is missing or malformed", () => {
    expectViolation(
      findConfigInvariantViolations(makeProject({ [PACKAGE_JSON]: null })),
      /cannot be read/,
    );

    expectViolation(
      findConfigInvariantViolations(
        makeProject({ "tsconfig.json": "{ not json" }),
      ),
      /cannot be parsed/,
    );
  });
});
describe("checkCapabilityBoundary", () => {
  it("passes the repository and inspects every configuration file", () => {
    const result = checkCapabilityBoundary(projectRoot);

    // The application owns its own lock, and an application with no
    // dependencies has none. Every configuration file that *does* exist must be
    // inspected, and the manifest is always required.
    const expected = REQUIRED_CONFIG_FILES.filter((file) => {
      try {
        Deno.statSync(path.join(projectRoot, file));
        return true;
      } catch {
        return false;
      }
    });

    assert.deepEqual(result.configFiles, expected);
    assert.ok(
      result.configFiles.includes(PACKAGE_JSON),
      "the application manifest is always inspected",
    );
    assert.equal(result.invariants, CONFIG_INVARIANTS.length);
  });

  it("reports every configuration violation together", () => {
    const root = makeProject({
      [PACKAGE_JSON]: JSON.stringify(
        { name: "sample", devDependencies: { "@types/node": "^22.0.0" } },
        null,
        2,
      ),
      [WORKER_TSCONFIG]: JSON.stringify(
        { compilerOptions: { lib: ["ES2022"], types: ["node"] } },
        null,
        2,
      ),
    });

    assert.throws(
      () => checkCapabilityBoundary(root),
      (error) => {
        assert.ok(error instanceof NodeBoundaryError);
        assert.match(error.message, /must not depend on "@types\/node"/);
        assert.match(error.message, /compilerOptions\.types must be empty/);
        return true;
      },
    );
  });

  it("fails closed when there is nothing to inspect", () => {
    const root = makeTempDir("boundary-empty-");

    assert.throws(
      () => checkCapabilityBoundary(root),
      /Refusing to pass a check that inspected nothing/,
    );
  });
});

describe("main", () => {
  it("returns 0 for the repository", () => {
    const lines = [];
    const io = {
      log: (message) => lines.push(message),
      error: (message) => lines.push(`error: ${message}`),
    };

    assert.equal(main([], io), 0);

    // The invariant count is fixed; the file count tracks the configuration
    // files the application actually has. An application with no dependencies
    // legitimately has no lock of its own, so the expected count is derived
    // rather than hard-coded.
    const inspected = REQUIRED_CONFIG_FILES.filter((file) => {
      try {
        Deno.statSync(path.join(projectRoot, file));
        return true;
      } catch {
        return false;
      }
    }).length;
    assert.ok(
      inspected > 0,
      "the repository must have configuration to inspect",
    );

    assert.match(
      lines[0],
      new RegExp(
        `^Capability boundary OK: ${CONFIG_INVARIANTS.length} configuration ` +
          `invariant\\(s\\) hold across ${inspected} configuration file\\(s\\)`,
      ),
    );
    assert.match(lines[0], /no "@types\/node" dependency/);
  });

  it("returns 1 with usage for unexpected arguments", () => {
    const lines = [];
    const io = {
      log: (message) => lines.push(message),
      error: (message) => lines.push(message),
    };

    assert.equal(main(["--root", "/tmp"], io), 1);
    assert.match(
      lines[0],
      /^Usage: deno run --allow-read --allow-env scripts\/check-node-boundary\.mjs/,
    );
  });
});

describe("Worker typecheck coverage", () => {
  /**
   * The same invocation the `check:worker` task uses. Running it in a copy lets
   * the test add a Worker module without touching the repository.
   */
  // The typecheck now runs the toolchain-owned compiler through the launcher, so
  // the copied project needs no `node_modules` of its own and shares nothing
  // with the toolchain tree.
  function typecheck(root) {
    const result = run(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        `--allow-write=${path.join(root, ".wrangler")}`,
        `--allow-run=${resolveTsc(toolchainRoot())}`,
        path.join(projectRoot, "scripts", "tsc-check.mjs"),
        "worker/tsconfig.json",
      ],
      cwd: root,
    });
    return {
      status: result.code,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  function makeWorkerProject() {
    const root = makeTempDir("boundary-worker-");

    for (
      const file of [
        "worker/index.ts",
        "worker/tsconfig.json",
        "worker-configuration.d.ts",
        "package.json",
        // A real application inherits the generator-managed pin projection.
        ".mise.toml",
        // The application owns its own lock, and a dependency-free application
        // has none; copy it only when it exists so the fixture matches a real
        // application instead of the old merged tree.
        ...(existsSync(path.join(projectRoot, "deno.lock"))
          ? ["deno.lock"]
          : []),
      ]
    ) {
      writeFile(root, file, readFileSync(path.join(projectRoot, file), "utf8"));
    }

    return root;
  }

  it("typechecks every Worker module, not only index.ts", () => {
    const root = makeWorkerProject();

    const clean = typecheck(root);
    assert.equal(clean.status, 0, clean.output);

    // Regression canary: before the include was widened, a new module was never
    // part of the program and this passed silently.
    writeFile(
      root,
      "worker/zz-canary.ts",
      "export const home = process.env.HOME;\n",
    );

    const broken = typecheck(root);
    assert.equal(broken.status, 1, broken.output);
    assert.match(broken.output, /zz-canary\.ts\(\d+,\d+\): error TS2591/);

    rmSync(path.join(root, "worker/zz-canary.ts"));
    const restored = typecheck(root);
    assert.equal(restored.status, 0, restored.output);
  });
});
