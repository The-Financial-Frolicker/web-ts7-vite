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
  assertAvailable,
  availabilityArgs,
  BUILD_TOOL_PINS,
  main,
  MISE_TOOL_ID,
  parseSpecification,
  renderMiseToml,
  SpecificationError,
  SPECIFIED_TOOLS,
} from "./toolchain-specify.mjs";
import { readToolchainTuple } from "./contracts/toolchain.mjs";

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

/** A deterministic mise double: it lists whatever version was asked for. */
function listsEveryVersion(args) {
  const [, specifier] = args;
  return { code: 0, stdout: `${specifier.split("@").pop()}\n`, stderr: "" };
}

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
  it("renders the four supplied versions as mise tool declarations", () => {
    const toml = renderMiseToml(SPEC);
    assert.match(toml, /^deno = "2\.9\.8"$/m);
    assert.match(toml, /^"npm:vite" = "8\.3\.5"$/m);
    assert.match(toml, /^"npm:wrangler" = "4\.156\.0"$/m);
    assert.match(toml, /^emsdk = "6\.0\.13"$/m);
    // Build prerequisites follow the tuple and never replace a tuple tool.
    assert.match(toml, new RegExp(`^cmake = "${BUILD_TOOL_PINS.cmake}"$`, "m"));
    assert.match(toml, new RegExp(`^ninja = "${BUILD_TOOL_PINS.ninja}"$`, "m"));
    // Vite and Wrangler are declared, so cmake/ninja are not standing in for them.
    assert.doesNotMatch(toml, /^vite = /m);
    assert.doesNotMatch(toml, /^wrangler = /m);
  });

  it("keeps the stale projection header out of the file", () => {
    const toml = renderMiseToml(SPEC);
    assert.doesNotMatch(toml, /toolchain\.toml/);
    assert.doesNotMatch(toml, /toolchain:prepare/);
  });

  it("declares the toolchain packages from the specified versions", () => {
    // `.mise.toml` is the only specification: the tuple from the command line,
    // and the additional toolchain packages pinned beside it.
    const toml = renderMiseToml(SPEC);
    for (
      const [id, version] of [
        ["npm:vite", SPEC.vite],
        ["npm:wrangler", SPEC.wrangler],
        ["npm:typescript", "7.0.2"],
        ["npm:@cloudflare/vite-plugin", "1.66.0"],
      ]
    ) {
      assert.match(toml, new RegExp(`^"${id}" = "${version}"$`, "m"));
    }
  });

  it("writes the single specification file and reports what changed", () => {
    const root = makeRoot();
    const changed = applySpecification({ root, specification: SPEC });
    // One specification: mise installs the toolchain, so there is no Deno
    // manifest to render and no lockfile to keep in step.
    assert.deepEqual(changed, [".mise.toml"]);
    assert.match(
      readFileSync(path.join(root, ".mise.toml"), "utf8"),
      /2\.9\.8/,
    );
    // The specification is the only artefact written, and it carries the
    // specified wrangler version.
    assert.match(
      readFileSync(path.join(root, ".mise.toml"), "utf8"),
      new RegExp(`^"npm:wrangler" = "${SPEC.wrangler}"$`, "m"),
    );
  });

  it("is idempotent: an unchanged specification writes nothing", () => {
    const root = makeRoot();
    applySpecification({ root, specification: SPEC });
    assert.deepEqual(applySpecification({ root, specification: SPEC }), []);
  });

  it("creates no installation and no dependency tree", () => {
    const root = makeRoot();
    main(ARGV, root, { log: () => {}, error: () => {} }, listsEveryVersion);
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
    }, listsEveryVersion);
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

describe("availability guard", () => {
  it("accepts a complete, available tuple and returns it unchanged", () => {
    const result = assertAvailable(SPEC, listsEveryVersion);
    assert.deepEqual(result, SPEC);
    assert.equal(result.deno, "2.9.8");
    assert.equal(result.vite, "8.3.5");
    assert.equal(result.wrangler, "4.156.0");
    assert.equal(result.emscripten, "6.0.13");
  });

  it("asks mise through the tool mapping, not through a pattern", () => {
    const seen = [];
    assertAvailable(SPEC, (args) => {
      seen.push(args);
      return { code: 0, stdout: `${args[1].split("@").pop()}\n`, stderr: "" };
    });
    assert.deepEqual(seen, [
      availabilityArgs("deno", "2.9.8"),
      availabilityArgs("vite", "8.3.5"),
      availabilityArgs("wrangler", "4.156.0"),
      availabilityArgs("emscripten", "6.0.13"),
    ]);
    assert.deepEqual(seen.map((args) => args[1]), [
      "deno@2.9.8",
      "npm:vite@8.3.5",
      "npm:wrangler@4.156.0",
      "emsdk@6.0.13",
    ]);
    assert.deepEqual(MISE_TOOL_ID, {
      deno: "deno",
      vite: "npm:vite",
      wrangler: "npm:wrangler",
      emscripten: "emsdk",
    });
  });

  it("rejects any tuple that leaves one tool missing", () => {
    for (const tool of SPECIFIED_TOOLS) {
      const argv = [];
      for (const other of SPECIFIED_TOOLS) {
        if (other === tool) continue;
        argv.push(`--${other}`, SPEC[other]);
      }

      assert.throws(
        () => parseSpecification(argv),
        new RegExp("missing version\\(s\\) for " + tool),
        `a tuple without ${tool} must be refused`,
      );
    }
  });

  it("rejects malformed versions before any lookup", () => {
    for (const value of ["8.3", "latest", "~8.3.5", "^8.3.5", "8.3.5.1", ""]) {
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
        SpecificationError,
      );
    }
  });

  it("rejects a version the release list does not contain", () => {
    const partial = { ...SPEC, wrangler: "4.156.7" };
    const runner = (args) => {
      const version = args[1].split("@").pop();
      // mise lists the versions it knows: this tuple's wrangler is absent.
      return version === "4.156.7"
        ? { code: 0, stdout: "4.156.2\n4.157.0\n4.158.0\n", stderr: "" }
        : { code: 0, stdout: `${version}\n`, stderr: "" };
    };

    assert.throws(
      () => assertAvailable(partial, runner),
      /wrangler 4\.156\.7 is not available through npm:wrangler/,
    );
  });

  it("never falls back to latest or another released version", () => {
    const runner = () => ({ code: 0, stdout: "latest\n8.3.6\n", stderr: "" });
    assert.throws(
      () => assertAvailable(SPEC, runner),
      /deno 2\.9\.8 is not available/,
    );
  });

  it("fails closed when the lookup itself fails", () => {
    const failing = () => ({
      code: 2,
      stdout: "",
      stderr: "network unreachable",
    });
    assert.throws(
      () => assertAvailable(SPEC, failing),
      /the mise availability lookup failed for deno 2\.9\.8 .*network unreachable/,
    );
  });

  it("fails closed when the runner throws", () => {
    const throwing = () => {
      throw new Error("mise is not installed");
    };
    assert.throws(
      () => assertAvailable(SPEC, throwing),
      /lookup failed for deno 2\.9\.8 .*mise is not installed/,
    );
  });

  it("fails closed when the runner returns no usable result", () => {
    assert.throws(
      () => assertAvailable(SPEC, () => undefined),
      /produced no result/,
    );
  });

  it("writes nothing when the tuple is not available", () => {
    const root = makeRoot();
    const errors = [];
    const code = main(ARGV, root, {
      log: () => {},
      error: (message) => errors.push(message),
    }, () => ({ code: 0, stdout: "", stderr: "" }));

    assert.equal(code, 1);
    assert.match(errors.join("\n"), /is not available through deno/);
    assert.equal(existsSync(path.join(root, ".mise.toml")), false);
    assert.equal(
      existsSync(path.join(root, "toolchain", "package.json")),
      false,
    );
  });

  it("writes nothing when a partial tuple is supplied", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, ".mise.toml"), "sentinel\n");
    const code = main(
      ["--deno", "2.9.8", "--vite", "8.3.5"],
      root,
      { log: () => {}, error: () => {} },
      listsEveryVersion,
    );
    assert.equal(code, 1);
    assert.equal(
      readFileSync(path.join(root, ".mise.toml"), "utf8"),
      "sentinel\n",
    );
  });

  it("carries the exact supplied values into the configuration", () => {
    const supplied = {
      deno: "2.9.8",
      vite: "8.3.5",
      wrangler: "4.156.0",
      emscripten: "6.0.13",
    };
    const validated = assertAvailable(supplied, listsEveryVersion);
    const toml = renderMiseToml(validated);
    for (const [tool, version] of Object.entries(supplied)) {
      assert.equal(validated[tool], version, `${tool} must survive validation`);
      assert.match(
        toml,
        new RegExp(version.replaceAll(".", "\\.")),
        `${tool} version must appear verbatim`,
      );
    }
  });
});

describe("the four-member tuple", () => {
  it("is exactly deno, vite, wrangler and emscripten", () => {
    assert.deepEqual([...SPECIFIED_TOOLS], [
      "deno",
      "vite",
      "wrangler",
      "emscripten",
    ]);
    assert.deepEqual(readToolchainTuple(Deno.cwd()), {
      deno: "2.9.8",
      vite: "8.3.5",
      wrangler: "4.156.0",
      emscripten: "6.0.13",
    });
  });

  it("excludes the CMake and Ninja build prerequisites", () => {
    const tuple = readToolchainTuple(Deno.cwd());
    for (const prerequisite of ["cmake", "ninja"]) {
      assert.equal(
        prerequisite in tuple,
        false,
        `${prerequisite} is not a tuple member`,
      );
    }
    // They are still declared for mise, after the four tuple tools.
    const toml = readFileSync(path.join(Deno.cwd(), ".mise.toml"), "utf8");
    assert.match(toml, new RegExp(`^cmake = "${BUILD_TOOL_PINS.cmake}"$`, "m"));
    assert.match(toml, new RegExp(`^ninja = "${BUILD_TOOL_PINS.ninja}"$`, "m"));
  });

  it("is exact for every member in the specification and the contract", () => {
    const tuple = readToolchainTuple(Deno.cwd());
    const toml = readFileSync(path.join(Deno.cwd(), ".mise.toml"), "utf8");
    const document = JSON.parse(
      readFileSync(path.join(Deno.cwd(), "toolchain-contracts.json"), "utf8"),
    );

    assert.deepEqual(document.toolchain.tuple.deno, tuple.deno);
    assert.deepEqual(document.toolchain.tuple.vite, tuple.vite);
    assert.deepEqual(document.toolchain.tuple.wrangler, tuple.wrangler);
    assert.deepEqual(document.toolchain.tuple.emscripten, tuple.emscripten);
    for (const value of Object.values(tuple)) {
      assert.match(value, /^\d+\.\d+\.\d+$/);
    }
    // A tuple member that is also an npm package is pinned exactly in the
    // specification mise installs from.
    for (
      const [id, version] of [["npm:vite", tuple.vite], [
        "npm:wrangler",
        tuple.wrangler,
      ]]
    ) {
      assert.match(toml, new RegExp(`^"${id}" = "${version}"$`, "m"));
    }
  });
});

describe("the build/deployment ownership boundary", () => {
  const toml = renderMiseToml(SPEC);

  it("declares the Cloudflare plugin as a toolchain package, never as an application dependency", () => {
    // The plugin is required to operate the Vite build, so mise installs it with
    // the toolchain. It must not be declared as an application dependency: the
    // application Deno tree owns application libraries only.
    assert.match(toml, /^"npm:@cloudflare\/vite-plugin" = "1\.66\.0"$/m);
  });

  it("keeps the exact TypeScript build dependency in the specification", () => {
    assert.match(toml, /^"npm:typescript" = "7\.0\.2"$/m);
  });

  it("pins the Vite plugin in the toolchain specification, not an application tree", () => {
    // The plugin is a toolchain package installed by mise. It must never be
    // declared as an application dependency: the application Deno tree owns
    // application libraries only.
    const toml = renderMiseToml(SPEC);
    assert.match(toml, /^"npm:@cloudflare\/vite-plugin" = "1\.66\.0"$/m);
    assert.match(toml, new RegExp(`^"npm:vite" = "${SPEC.vite}"$`, "m"));
    assert.match(
      toml,
      new RegExp(`^"npm:wrangler" = "${SPEC.wrangler}"$`, "m"),
    );
  });
});
