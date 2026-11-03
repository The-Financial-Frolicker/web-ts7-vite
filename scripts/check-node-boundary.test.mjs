import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  checkCapabilityBoundary,
  CONFIG_INVARIANTS,
  DENO_LOCK,
  findConfigInvariantViolations,
  findLockedNodeTypes,
  findSourcePolicyViolations,
  listSourceFiles,
  main,
  NodeBoundaryError,
  PACKAGE_JSON,
  scanSegments,
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
    "src/main.ts": "export const answer = 42;\n",
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

describe("scanSegments", () => {
  it("separates code from comments", () => {
    const { code, comments } = scanSegments(
      "const a = 1; // trailing\n/* block */ const b = 2;\n",
    );

    assert.equal(comments.length, 2);
    assert.match(comments[0].text, /^\/\/ trailing$/);
    assert.match(comments[1].text, /^\/\* block \*\/$/);
    assert.doesNotMatch(code.map((span) => span.text).join(""), /trailing/);
  });

  it("does not treat comment-like text inside literals as a comment", () => {
    const source = [
      'const a = "// not a comment";',
      "const b = `/* not a comment */`;",
      "const c = /[/][/]@ts-ignore/;",
    ].join("\n");

    assert.deepEqual(scanSegments(source).comments, []);
  });

  it("keeps a regex containing // from opening a comment", () => {
    const source = "const re = /\\/\\/@ts-ignore/;\nconst after = 1;\n";
    const { code, comments } = scanSegments(source);

    assert.deepEqual(comments, []);
    assert.match(code.map((span) => span.text).join(""), /const after = 1;/);
  });
});
describe("findSourcePolicyViolations", () => {
  it("accepts a clean project", () => {
    assert.deepEqual(findSourcePolicyViolations(makeProject()), []);
  });

  it("rejects an ambient node: module declaration", () => {
    const root = makeProject({
      "src/zz-ambient.d.ts":
        'declare module "node:fs" {\n  const x: unknown;\n  export default x;\n}\n',
    });

    const violation = expectViolation(
      findSourcePolicyViolations(root),
      /declares the ambient module "node:fs"/,
    );
    assert.equal(violation.file, "src/zz-ambient.d.ts");
    assert.equal(violation.line, 1);
  });

  it("rejects an ambient cloudflare: module declaration in the Worker", () => {
    const root = makeProject({
      "worker/zz-ambient.ts":
        'declare module "cloudflare:sockets" {}\nexport const a = 1;\n',
    });

    const violation = expectViolation(
      findSourcePolicyViolations(root),
      /declares the ambient module "cloudflare:sockets"/,
    );
    assert.match(violation.file, /^worker\//);
  });

  it("accepts ambient declarations for non-capability modules", () => {
    const root = makeProject({
      "src/zz-css.d.ts": 'declare module "*.css";\n',
      "src/zz-local.d.ts": 'declare module "./local.js";\n',
    });

    assert.deepEqual(findSourcePolicyViolations(root), []);
  });

  it("ignores an ambient declaration quoted in a comment or string", () => {
    const root = makeProject({
      "src/zz-mentions.ts": [
        '// declare module "node:fs" is rejected by policy',
        "const text = 'declare module \"node:fs\"';",
        "export const a = 1;",
        "",
      ].join("\n"),
    });

    assert.deepEqual(findSourcePolicyViolations(root), []);
  });

  it("rejects TypeScript suppression directives in comments", () => {
    for (const directive of ["@ts-ignore", "@ts-expect-error"]) {
      const root = makeProject({
        "src/zz-suppressed.ts": [
          "// justification",
          `// ${directive} deliberate`,
          "export const a = 1;",
          "",
        ].join("\n"),
      });

      const violation = expectViolation(
        findSourcePolicyViolations(root),
        new RegExp(`uses the TypeScript suppression directive "${directive}"`),
      );
      assert.equal(violation.line, 2);
      assert.equal(violation.column, 4);
    }
  });

  it("accepts the directive text inside a string literal", () => {
    const root = makeProject({
      "src/zz-string.ts": 'export const note = "never use @ts-ignore";\n',
    });

    assert.deepEqual(findSourcePolicyViolations(root), []);
  });

  it("skips test files", () => {
    const root = makeProject({
      "src/zz.test.ts": "// @ts-expect-error fixture\nexport const a = 1;\n",
    });

    assert.deepEqual(findSourcePolicyViolations(root), []);
  });

  it("does not inspect computed dynamic imports", () => {
    // Documented residual gap of this stage, not a policy: keeping it covered
    // makes a future change deliberate.
    const root = makeProject({
      "src/zz-computed.ts": 'const name = "node:" + "fs";\n' +
        "export const load = async () => await import(name);\n",
    });

    assert.deepEqual(findSourcePolicyViolations(root), []);
  });

  it("lists protected source files and skips tests", () => {
    const root = makeProject({
      "worker/extra.ts": "export const a = 1;\n",
      "worker/extra.test.ts": "export const b = 2;\n",
    });

    assert.deepEqual(listSourceFiles(root), ["src/main.ts", "worker/extra.ts"]);
  });
});
describe("stripJsonComments", () => {
  it("removes comments so JSONC parses", () => {
    const jsonc =
      '{\n  // comment\n  "a": 1, /* inline */\n  "b": "// kept"\n}\n';

    assert.deepEqual(JSON.parse(stripJsonComments(jsonc)), {
      a: 1,
      b: "// kept",
    });
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
  it("passes the repository and inspects the real source", () => {
    const result = checkCapabilityBoundary(projectRoot);

    assert.ok(result.files.includes("src/main.ts"));
    assert.ok(result.files.includes("worker/index.ts"));
    assert.equal(result.invariants, CONFIG_INVARIANTS.length);
  });

  it("reports configuration and source violations together", () => {
    const root = makeProject({
      [PACKAGE_JSON]: JSON.stringify(
        { name: "sample", devDependencies: { "@types/node": "^22.0.0" } },
        null,
        2,
      ),
      "src/zz-suppressed.ts": "// @ts-ignore\nexport const a = 1;\n",
    });

    assert.throws(
      () => checkCapabilityBoundary(root),
      (error) => {
        assert.ok(error instanceof NodeBoundaryError);
        assert.match(error.message, /must not depend on "@types\/node"/);
        assert.match(error.message, /src\/zz-suppressed\.ts:1:4/);
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
    assert.match(
      lines[0],
      /^Capability boundary OK: 3 protected source file\(s\)/,
    );
  });

  it("returns 1 with usage for unexpected arguments", () => {
    const lines = [];
    const io = {
      log: (message) => lines.push(message),
      error: (message) => lines.push(message),
    };

    assert.equal(main(["--root", "/tmp"], io), 1);
    assert.match(lines[0], /^Usage: node scripts\/check-node-boundary\.mjs/);
  });
});

describe("Worker typecheck coverage", () => {
  /**
   * The same invocation the `check:worker` task uses. Running it in a copy lets
   * the test add a Worker module without touching the repository.
   */
  const TYPECHECK = [
    "run",
    "--allow-read",
    "--allow-env",
    "--allow-run",
    "--cached-only",
    "--frozen",
    "npm:typescript@7.0.2",
    "-p",
    "worker/tsconfig.json",
  ];

  function makeWorkerProject() {
    const root = makeTempDir("boundary-worker-");

    for (
      const file of [
        "worker/index.ts",
        "worker/tsconfig.json",
        "worker-configuration.d.ts",
        "package.json",
        "deno.lock",
      ]
    ) {
      writeFile(root, file, readFileSync(path.join(projectRoot, file), "utf8"));
    }

    // The npm resolver expects an installed tree; share the repository's, as
    // scripts/ci.sh does for its throwaway build copy.
    symlinkSync(
      path.join(projectRoot, "node_modules"),
      path.join(root, "node_modules"),
      "dir",
    );

    return root;
  }

  function typecheck(root) {
    const result = spawnSync("deno", TYPECHECK, {
      cwd: root,
      encoding: "utf8",
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
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
