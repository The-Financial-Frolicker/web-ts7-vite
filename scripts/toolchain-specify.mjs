/**
 * Establish the generator's toolchain specification from explicit versions.
 *
 *   deno task toolchain:specify -- \
 *     --deno 2.9.8 --vite 8.3.5 --wrangler 4.156.0 --emscripten 6.0.13
 *
 * The four versions supplied here are the *only* version authority in this
 * project. Nothing is read from the environment, a shell profile, a previous
 * installation, or an implicit "latest" resolution.
 *
 * This task writes the specification — the mise configuration (`.mise.toml`)
 * and the toolchain manifest (`toolchain/package.json`) — and installs nothing.
 * Writing the specification is what the invariants require; mutating an
 * *installed* toolchain is what they prohibit. `mise install` and, when the
 * manifest changes, Deno's own re-lock remain native steps performed once by
 * the operator or CI.
 */

import { readFileSync } from "./lib/fs.mjs";
import path from "./lib/path.mjs";
// The tuple definition lives in the contract module the product also receives,
// so no shipped module depends on this generator-only specification script.
import { MISE_TOOL_ID, SPECIFIED_TOOLS } from "./contracts/toolchain.mjs";

export { MISE_TOOL_ID, SPECIFIED_TOOLS };

export const MISE_FILE = ".mise.toml";
export const TOOLCHAIN_DIR = "toolchain";
export const TOOLCHAIN_PACKAGE = "package.json";

/**
 * Build prerequisites this generator pins itself.
 *
 * They are not part of the toolchain tuple: the operator specifies Deno, Vite,
 * Wrangler and Emscripten. CMake and Ninja are what `scripts/build-wasm.sh`
 * invokes (`cmake -G Ninja`), so they remain explicit constants rather than
 * being discovered or inherited, and they never take the place of a tuple tool.
 */
export const BUILD_TOOL_PINS = Object.freeze({
  cmake: "4.4.5",
  ninja: "1.13.2",
});

/**
 * Toolchain-owned packages whose versions are engine constants rather than
 * operator inputs (the specified packages are `vite` and `wrangler`).
 */
/**
 * Build-toolchain libraries installed by mise, at exact versions.
 *
 * Only packages the *certified build* needs belong here. `typescript` is the
 * compiler `scripts/tsc-check.mjs` uses, pinned to the version the Deno lock
 * already resolves (`npm:typescript@~7.0.2` -> 7.0.2), which is also the version
 * the installation record reports.
 *
 * `@cloudflare/vite-plugin` is deliberately absent. It is deployment
 * integration, owned by the Deno application dependency domain
 * (`toolchain/package.json`, written by `renderToolchainPackage` below) together
 * with its own dependency closure. That closure may legitimately contain private
 * copies of packages the build toolchain also uses; that is ordinary package
 * isolation inside an application-owned tree and does not affect toolchain
 * ownership, the certified closure or its independence.
 */
export const TOOLCHAIN_LIBRARIES = Object.freeze({
  typescript: "7.0.2",
});

export const ENGINE_PACKAGES = Object.freeze({
  typescript: "~7.0.2",
  "@cloudflare/vite-plugin": "1.66.0",
});

/** Exact `X.Y.Z`; ranges, tags and implicit resolution are not accepted. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export class SpecificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpecificationError";
  }
}

function fail(message) {
  throw new SpecificationError(message);
}

/** Parse the four required options; nothing else is accepted. */
export function parseSpecification(argv) {
  const values = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (!argument.startsWith("--")) {
      fail(
        `unexpected argument ${JSON.stringify(argument)}; versions are options`,
      );
    }

    const [name, inline] = argument.slice(2).split("=", 2);
    if (!SPECIFIED_TOOLS.includes(name)) {
      fail(
        `unknown tool ${JSON.stringify(name)}; specify exactly ${
          SPECIFIED_TOOLS.join(", ")
        }`,
      );
    }

    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (value === undefined || value.startsWith("--")) {
      fail(`--${name} requires an exact version`);
    }
    if (name in values) {
      fail(`--${name} was supplied more than once`);
    }
    if (!VERSION_PATTERN.test(value)) {
      fail(
        `--${name} ${JSON.stringify(value)} is not an exact X.Y.Z version; ` +
          `ranges, tags and implicit resolution are not version authority`,
      );
    }

    values[name] = value;
  }

  const missing = SPECIFIED_TOOLS.filter((tool) => !(tool in values));
  if (missing.length > 0) {
    fail(
      `missing version(s) for ${missing.join(", ")}; every invocation must ` +
        `specify ${SPECIFIED_TOOLS.join(", ")}`,
    );
  }

  return Object.freeze(values);
}

/**
 * The mise configuration specification for these versions.
 *
 * The four supplied versions are the toolchain tuple and appear as mise tool
 * declarations: `deno`, `npm:vite`, `npm:wrangler` and `emsdk` (Emscripten).
 * CMake and Ninja follow as build prerequisites, which the WASM build invokes
 * directly; they are never substituted for a tuple tool.
 */
export function renderMiseToml(specification) {
  const lines = [
    "# Generated by `deno task toolchain:specify` from the four versions supplied",
    "# on the command line. This is the project's mise configuration: mise installs",
    "# and selects the tools declared here.",
    "#",
    "# The toolchain tuple is deno, vite, wrangler and emsdk (the mise tool for",
    "# Emscripten). CMake and Ninja below are build prerequisites of the WASM",
    "# build, not part of the tuple.",
    "",
    "[tools]",
  ];

  for (const tool of SPECIFIED_TOOLS) {
    const id = MISE_TOOL_ID[tool];
    const key = id.includes(":") ? `"${id}"` : id;
    lines.push(`${key} = "${specification[tool]}"`);
  }

  for (const [name, version] of Object.entries(TOOLCHAIN_LIBRARIES)) {
    lines.push(`"npm:${name}" = "${version}"`);
  }

  lines.push(
    `cmake = "${BUILD_TOOL_PINS.cmake}"`,
    `ninja = "${BUILD_TOOL_PINS.ninja}"`,
    "",
    "# Python is NOT project-managed. Emscripten needs the host's python3 (>= 3.10);",
    "# scripts/resolve-python.sh uses it when present and only provisions a fallback",
    "# at the requirement the installed SDK reports when the host cannot satisfy it.",
    "# Node.js is not used to execute any project workflow. Deno runs every task,",
    "# check, the Vite build, the development and preview servers and deployment.",
    "# Emscripten's bundled Node stays private to the SDK and never runs project code.",
    "",
  );

  return lines.join("\n");
}

/** The toolchain manifest for these versions (lock input, not a live tree). */
export function renderToolchainPackage(specification) {
  return `${
    JSON.stringify(
      {
        name: "web-ts7-vite-toolchain",
        private: true,
        type: "module",
        dependencies: {
          "@cloudflare/vite-plugin": ENGINE_PACKAGES["@cloudflare/vite-plugin"],
          typescript: ENGINE_PACKAGES.typescript,
          vite: specification.vite,
          wrangler: specification.wrangler,
        },
      },
      null,
      2,
    )
  }\n`;
}

/**
 * The mise command that decides whether a supplied version can be installed.
 *
 * This is mise's own availability query, not a pattern match: a version that is
 * well-formed but absent from the tool's release list is not installable, and
 * the specification must not be written in that case.
 */
export function availabilityArgs(tool, version) {
  return ["ls-remote", `${MISE_TOOL_ID[tool]}@${version}`];
}

/** Default runner: one bounded, non-interactive `mise` invocation. */
export function createMiseRunner({ command = "mise" } = {}) {
  const decoder = new TextDecoder();
  return (args) => {
    try {
      const output = new Deno.Command(command, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).outputSync();
      return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      };
    } catch (error) {
      return { code: -1, stdout: "", stderr: error.message };
    }
  };
}

/**
 * Fail unless every supplied version is available through mise.
 *
 * Runs before anything is written, so an incomplete or uninstallable tuple can
 * never reach the configuration files, the installation or the qualification.
 * The supplied values are returned unchanged: nothing is normalised, defaulted
 * or resolved to `latest`.
 */
export function assertAvailable(specification, run = createMiseRunner()) {
  for (const tool of SPECIFIED_TOOLS) {
    const version = specification[tool];
    const args = availabilityArgs(tool, version);

    let result;
    try {
      result = run(args);
    } catch (error) {
      fail(
        `the mise availability lookup failed for ${tool} ${version} ` +
          `(${args.join(" ")}): ${error.message}`,
      );
    }

    if (
      result === undefined || result === null || typeof result.code !== "number"
    ) {
      fail(
        `the mise availability lookup for ${tool} ${version} ` +
          `(${args.join(" ")}) produced no result`,
      );
    }

    if (result.code !== 0) {
      fail(
        `the mise availability lookup failed for ${tool} ${version} ` +
          `(${args.join(" ")}, exit ${result.code}): ` +
          `${(result.stderr || result.stdout || "").trim()}`,
      );
    }

    const listed = String(result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (!listed.includes(version)) {
      fail(
        `${tool} ${version} is not available through ${
          MISE_TOOL_ID[tool]
        }; the release list does not include it, so nothing was written`,
      );
    }
  }

  return specification;
}

/**
 * Write the specification. Returns which files changed so the caller can report
 * it; an unchanged specification writes nothing.
 */
export function applySpecification({ root, specification }) {
  const targets = [
    { file: MISE_FILE, text: renderMiseToml(specification) },
    {
      file: path.join(TOOLCHAIN_DIR, TOOLCHAIN_PACKAGE),
      text: renderToolchainPackage(specification),
    },
  ];

  const changed = [];
  for (const target of targets) {
    const absolute = path.join(root, target.file);
    let current = null;
    try {
      current = readFileSync(absolute, "utf8");
    } catch {
      // A missing specification file is written, not treated as an error.
    }
    if (current === target.text) continue;
    Deno.writeTextFileSync(absolute, target.text);
    changed.push(target.file);
  }

  return changed;
}

/** CLI entry point; returns an exit code. */
export function main(
  argv = Deno.args,
  root = Deno.cwd(),
  io = console,
  run = createMiseRunner(),
) {
  try {
    const specification = parseSpecification(argv);
    // Availability first: a tuple that cannot be installed never reaches the
    // specification files, the installation or the qualification.
    assertAvailable(specification, run);
    const changed = applySpecification({ root, specification });

    io.log(
      `[toolchain] specified deno=${specification.deno} ` +
        `vite=${specification.vite} wrangler=${specification.wrangler} ` +
        `emscripten=${specification.emscripten}`,
    );
    io.log(
      changed.length === 0
        ? "[toolchain] specification already current; nothing written"
        : `[toolchain] wrote ${changed.join(", ")}`,
    );
    io.log(
      "[toolchain] next: run `mise install` once to establish the specified " +
        "installation, then `deno task toolchain:install` to materialise the " +
        "locked packages. A changed toolchain manifest needs Deno's own re-lock " +
        "(`deno install` in toolchain/) before that.",
    );
    return 0;
  } catch (error) {
    if (error instanceof SpecificationError) {
      io.error(`Error: ${error.message}`);
      return 1;
    }
    if (error instanceof Deno.errors.NotFound) {
      io.error(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  Deno.exitCode = main();
}
