/**
 * Tests for the explicit toolchain specification.
 *
 * The specified versions are the only version authority: they arrive as
 * command-line arguments, reach the mise configuration and the toolchain
 * manifest unchanged, and nothing is read from the environment or resolved.
 */

import assert from "./lib/assert.mjs";
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
import {
  applySpecification,
  BUILD_TOOL_PINS,
  ENGINE_PACKAGES,
  main,
  parseSpecification,
  renderMiseToml,
  renderToolchainPackage,
  SpecificationError,
  SPECIFIED_TOOLS,
} from "./toolchain-specify.mjs";

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot() {
  const root = Deno.realPathSync(
    mkdtempSync(path.join(os.tmpdir(), "specify-")),
  );
  temporaryRoots.push(root);
  mkdirSync(path.join(root, "toolchain"), { recursive: true });
  return root;
}

const SPEC = Object.freeze({
  deno: "2.9.8",
  vite: "8.3.5",
  wrangler: "4.156.0",
  emscripten: "6.0.13",
});

const ARGV = Object.freeze([
  "--deno",
  "2.9.8",
  "--vite",
  "8.3.5",
  "--wrangler",
  "4.156.0",
  "--emscripten",
  "6.0.13",
]);

describe("explicit version authority", () => {
  it("accepts exactly the four specified tools", () => {
    assert.deepEqual(parseSpecification(ARGV), SPEC);
  });

  it("accepts --tool=version form as well", () => {
    assert.deepEqual(
      parseSpecification(
        SPECIFIED_TOOLS.map((tool) => `--${tool}=${SPEC[tool]}`),
      ),
      SPEC,
    );
  });

  it("refuses an invocation that leaves any tool unspecified", () => {
    for (const tool of SPECIFIED_TOOLS) {
      const partial = SPECIFIED_TOOLS
        .filter((candidate) => candidate !== tool)
        .flatMap((candidate) => [`--${candidate}`, SPEC[candidate]]);
      assert.throws(
        () => parseSpecification(partial),
        (error) =>
          error instanceof SpecificationError &&
          new RegExp(`missing version\\(s\\) for ${tool}`).test(error.message),
        `${tool} must be required`,
      );
    }
  });

  it("refuses ranges, tags and implicit resolution", () => {
    for (const value of ["latest", "^8.3.5", "~8.3.5", "8", "8.3", "main"]) {
      assert.throws(
        () =>
          parseSpecification([
            "--deno",
            "2.9.8",
            "--vite",
            value,
            "--wrangler",
            "4.156.0",
            "--emscripten",
            "6.0.13",
          ]),
        /is not an exact X\.Y\.Z version/,
        `${value} must be refused`,
      );
    }
  });

  it("refuses unknown options, duplicate tools and stray arguments", () => {
    assert.throws(
      () => parseSpecification([...ARGV, "--typescript", "7.0.2"]),
      /unknown tool "typescript"/,
    );
    assert.throws(
      () => parseSpecification([...ARGV, "--deno", "2.9.9"]),
      /--deno was supplied more than once/,
    );
    assert.throws(
      () => parseSpecification([...ARGV, "9.9.9"]),
      /unexpected argument "9\.9\.9"/,
    );
  });
});

describe("environment independence", () => {
  it("cannot be shadowed by ambient variables", () => {
    const names = [
      "MISE_DENO_VERSION",
      "DENO_VERSION",
      "EMSDK",
      "EMSDK_ROOT",
      "TOOLCHAIN_ROOT",
      "GENERATOR_ROOT",
    ];
    const before = new Map(names.map((name) => [name, Deno.env.get(name)]));
    try {
      for (const name of names) Deno.env.set(name, "1.0.0");
      assert.deepEqual(parseSpecification(ARGV), SPEC);
    } finally {
      for (const [name, value] of before) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  });
});

describe("the specification is written, never installed", () => {
  it("renders the mise configuration from the specified versions", () => {
    const toml = renderMiseToml(SPEC);
    assert.match(toml, /^deno = "2\.9\.8"$/m);
    assert.match(toml, /^emsdk = "6\.0\.13"$/m);
    // Build prerequisites are this generator's own constants.
    assert.match(toml, new RegExp(`^cmake = "${BUILD_TOOL_PINS.cmake}"$`, "m"));
    assert.match(toml, new RegExp(`^ninja = "${BUILD_TOOL_PINS.ninja}"$`, "m"));
  });

  it("renders the toolchain manifest from the specified versions", () => {
    const manifest = JSON.parse(renderToolchainPackage(SPEC));
    assert.equal(manifest.dependencies.vite, SPEC.vite);
    assert.equal(manifest.dependencies.wrangler, SPEC.wrangler);
    assert.equal(manifest.dependencies.typescript, ENGINE_PACKAGES.typescript);
    assert.equal(
      manifest.dependencies["@cloudflare/vite-plugin"],
      ENGINE_PACKAGES["@cloudflare/vite-plugin"],
    );
  });

  it("writes both specification files and reports what changed", () => {
    const root = makeRoot();
    const changed = applySpecification({ root, specification: SPEC });
    assert.deepEqual(changed, [".mise.toml", "toolchain/package.json"]);
    assert.match(
      readFileSync(path.join(root, ".mise.toml"), "utf8"),
      /2\.9\.8/,
    );
    assert.equal(
      JSON.parse(
        readFileSync(path.join(root, "toolchain/package.json"), "utf8"),
      )
        .dependencies.wrangler,
      SPEC.wrangler,
    );
  });

  it("is idempotent: an unchanged specification writes nothing", () => {
    const root = makeRoot();
    applySpecification({ root, specification: SPEC });
    assert.deepEqual(applySpecification({ root, specification: SPEC }), []);
  });

  it("creates no installation and no dependency tree", () => {
    const root = makeRoot();
    main(ARGV, root, { log: () => {}, error: () => {} });
    assert.equal(existsSync(path.join(root, "generator")), false);
    assert.equal(
      existsSync(path.join(root, "toolchain", "node_modules")),
      false,
    );
    assert.equal(existsSync(path.join(root, "toolchain", "deno.lock")), false);
  });

  it("reports a specification error without writing files", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, ".mise.toml"), "sentinel\n");
    const errors = [];
    const code = main(["--deno", "2.9.8"], root, {
      log: () => {},
      error: (message) => errors.push(message),
    });
    assert.equal(code, 1);
    assert.match(
      errors.join("\n"),
      /missing version\(s\) for vite, wrangler, emscripten/,
    );
    assert.equal(
      readFileSync(path.join(root, ".mise.toml"), "utf8"),
      "sentinel\n",
    );
  });
});
