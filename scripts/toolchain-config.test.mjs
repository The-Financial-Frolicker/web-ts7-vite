/**
 * Toolchain configuration, resolution and installation tests.
 *
 * The mise boundary is injected, so these run offline and install nothing.
 * Real mise resolution is exercised separately, without installation.
 */
import assert from "./lib/assert.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";

import {
  isValidVersionDeclaration,
  loadToolchainConfig,
  newestVersion,
  parseAvailableVersions,
  parseToolchainConfig,
  projectMiseToml,
  ToolchainConfigError,
} from "./lib/toolchain/versions.mjs";
import {
  describeProvenance,
  installToolchain,
  parseInstalled,
  resolveToolchain,
  verifyInstalled,
} from "./lib/toolchain/resolve.mjs";
import { main as prepareMain } from "./toolchain-prepare.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const AVAILABLE = {
  deno: "2.9.7\n2.9.8\n2.9.10\n",
  cmake: "4.4.4\n4.4.5\n",
  ninja: "1.13.1\n1.13.2\n",
  emsdk: "6.0.12\n6.0.13\n",
};

/** A fake mise: records calls and answers from fixed tables. */
function makeRunner({ installed, failOn = null } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (failOn !== null && args[0] === failOn) {
      return { code: 1, stdout: "", stderr: "boom" };
    }
    if (args[0] === "ls-remote") {
      const versions = AVAILABLE[args[1]];
      return versions === undefined
        ? { code: 1, stdout: "", stderr: "unknown tool" }
        : { code: 0, stdout: versions, stderr: "" };
    }
    if (args[0] === "install") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "ls") {
      return {
        code: 0,
        stdout: Object.entries(installed ?? {})
          .map(([tool, version]) =>
            `${tool}   ${version}   .mise.toml   ${version}`
          )
          .join("\n"),
        stderr: "",
      };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };

  return { run, calls };
}

const ALL_EXACT = `[tools]
deno = "2.9.8"
cmake = "4.4.5"
ninja = "1.13.2"
emsdk = "6.0.13"
`;

describe("configuration parsing and validation", () => {
  it("parses explicit versions", () => {
    const entries = loadToolchainConfig(ALL_EXACT);

    assert.deepEqual(entries.map((entry) => entry.tool), [
      "deno",
      "cmake",
      "ninja",
      "emsdk",
    ]);
    assert.equal(entries[0].requested, "2.9.8");
    assert.equal(entries[0].source, "explicit");
  });

  it("defaults omitted tools to latest and keeps explicit latest", () => {
    const entries = loadToolchainConfig(
      `[tools]\ndeno = "latest"\ncmake = "4.4.5"\n`,
    );
    const byTool = Object.fromEntries(
      entries.map((entry) => [entry.tool, entry]),
    );

    assert.equal(byTool.deno.requested, "latest");
    assert.equal(byTool.deno.source, "latest");
    assert.equal(byTool.cmake.source, "explicit");
    assert.equal(byTool.ninja.requested, "latest");
    assert.equal(byTool.ninja.source, "omitted");
    assert.equal(byTool.emsdk.source, "omitted");
  });

  it("ignores comments, including a # after a version", () => {
    const tools = parseToolchainConfig(
      `# header\n[tools]\ndeno = "2.9.8" # pinned\n`,
    );

    assert.equal(tools.deno, "2.9.8");
  });

  it("rejects malformed configuration", () => {
    for (
      const bad of [
        `deno = "2.9.8"`,
        `[other]\ndeno = "2.9.8"`,
        `[tools]\ndeno = 2.9.8`,
        `[tools]\ndeno = "2.9.8"\ndeno = "2.9.7"`,
        `[tools]\n= "1"`,
        ``,
      ]
    ) {
      assert.throws(
        () => loadToolchainConfig(bad),
        ToolchainConfigError,
        JSON.stringify(bad),
      );
    }
  });

  it("rejects unsupported tools and invalid versions", () => {
    assert.throws(
      () => loadToolchainConfig(`[tools]\nnode = "24.19.0"`),
      /unsupported tool "node"/,
    );
    assert.throws(
      () => loadToolchainConfig(`[tools]\ndeno = "latst"`),
      /invalid version "latst"/,
    );
    assert.throws(
      () => loadToolchainConfig(`[tools]\ndeno = ">=2"`),
      /invalid version/,
    );
  });

  it("accepts only latest or exact versions", () => {
    for (const value of ["latest", "1", "1.2", "1.2.3", "1.2.3-rc.1"]) {
      assert.equal(isValidVersionDeclaration(value), true, value);
    }
    for (const value of ["", "v1.2.3", "1.2.3.4", "^1.2.3"]) {
      assert.equal(isValidVersionDeclaration(value), false, value);
    }
  });

  it("represents a pre-existing toolchain written by a scanner", () => {
    const entries = loadToolchainConfig(ALL_EXACT);
    const mise = parseToolchainConfig(
      readFileSync(path.join(projectRoot, ".mise.toml"), "utf8"),
    );

    for (const entry of entries) {
      assert.equal(entry.source, "explicit");
      assert.equal(mise[entry.tool], entry.requested);
    }
  });
});

describe("resolution", () => {
  it("resolves latest to the highest available version", () => {
    const { run } = makeRunner({});
    const resolution = resolveToolchain({
      entries: loadToolchainConfig(`[tools]\ndeno = "latest"`),
      run,
    });
    const deno = resolution.find((entry) => entry.tool === "deno");

    assert.equal(deno.resolved, "2.9.10", "2.9.10 must beat 2.9.8");
    assert.equal(deno.requested, "latest");
  });

  it("verifies an explicit version exists and never treats it as latest", () => {
    const { run } = makeRunner({});
    const ok = resolveToolchain({
      entries: loadToolchainConfig(`[tools]\ndeno = "2.9.7"`),
      run,
    });
    assert.equal(ok.find((entry) => entry.tool === "deno").resolved, "2.9.7");

    assert.throws(
      () =>
        resolveToolchain({
          entries: loadToolchainConfig(`[tools]\ndeno = "0.0.1"`),
          run,
        }),
      /not available from mise/,
    );
  });

  it("fails clearly when mise cannot list versions", () => {
    const { run } = makeRunner({ failOn: "ls-remote" });

    assert.throws(
      () => resolveToolchain({ entries: loadToolchainConfig(ALL_EXACT), run }),
      /failed \(exit 1\)/,
    );
  });

  it("sorts numerically rather than lexicographically", () => {
    assert.equal(newestVersion(["2.9.9", "2.9.10", "2.9.8"]), "2.9.10");
    assert.equal(newestVersion(["1.0.0"]), "1.0.0");
    assert.equal(newestVersion([]), null);
    assert.deepEqual(parseAvailableVersions("1.0.0\nlatest\n2.0.0\n"), [
      "1.0.0",
      "2.0.0",
    ]);
  });
});

describe("installation", () => {
  it("resolves everything before installing anything", () => {
    const { run, calls } = makeRunner({});
    const resolution = resolveToolchain({
      entries: loadToolchainConfig(`[tools]\ndeno = "latest"\ncmake = "4.4.5"`),
      run,
    });

    assert.equal(calls.filter((args) => args[0] === "install").length, 0);

    installToolchain({ resolution, run, io: { log: () => {} } });
    assert.deepEqual(
      calls.filter((args) => args[0] === "install").map((args) => args[1]),
      ["deno@2.9.10", "cmake@4.4.5", "ninja@1.13.2", "emsdk@6.0.13"],
    );
  });

  it("installs the exact resolved versions", () => {
    const { run, calls } = makeRunner({});
    const resolution = resolveToolchain({
      entries: loadToolchainConfig(ALL_EXACT),
      run,
    });

    installToolchain({ resolution, run, io: { log: () => {} } });

    assert.deepEqual(
      calls.filter((args) => args[0] === "install").map((args) => args[1]),
      ["deno@2.9.8", "cmake@4.4.5", "ninja@1.13.2", "emsdk@6.0.13"],
    );
  });

  it("does not install when resolution fails", () => {
    const { run, calls } = makeRunner({});

    assert.throws(
      () =>
        resolveToolchain({
          entries: loadToolchainConfig(
            `[tools]\ndeno = "9.9.9"\ncmake = "4.4.5"`,
          ),
          run,
        }),
      /not available/,
    );
    assert.equal(calls.filter((args) => args[0] === "install").length, 0);
  });

  it("stops installation when mise rejects a version", () => {
    const { run } = makeRunner({ failOn: "install" });
    const resolution = resolveToolchain({
      entries: loadToolchainConfig(ALL_EXACT),
      run,
    });

    assert.throws(
      () => installToolchain({ resolution, run, io: { log: () => {} } }),
      /mise install deno@2\.9\.8 failed/,
    );
  });
});

describe("verification and provenance", () => {
  it("accepts matching installed versions and ignores ambient tools", () => {
    const { run } = makeRunner({
      installed: {
        deno: "2.9.8",
        cmake: "4.4.5",
        ninja: "1.13.2",
        emsdk: "6.0.13",
        node: "24.19.0",
        python: "3.13.18",
      },
    });
    const resolution = resolveToolchain({
      entries: loadToolchainConfig(ALL_EXACT),
      run,
    });

    const verified = verifyInstalled({ resolution, run });

    assert.equal(
      verified.find((entry) => entry.tool === "deno").installed,
      "2.9.8",
    );
    assert.equal(parseInstalled("node 24.19.0\n").node, "24.19.0");
  });

  it("rejects an installed version that differs from the resolved one", () => {
    const { run } = makeRunner({
      installed: {
        deno: "2.9.7",
        cmake: "4.4.5",
        ninja: "1.13.2",
        emsdk: "6.0.13",
      },
    });
    const resolution = resolveToolchain({
      entries: loadToolchainConfig(ALL_EXACT),
      run,
    });

    assert.throws(
      () => verifyInstalled({ resolution, run }),
      /deno resolved to 2\.9\.8 but 2\.9\.7 is installed/,
    );
  });

  it("rejects a tool that is not installed at all", () => {
    const { run } = makeRunner({ installed: { deno: "2.9.8" } });
    const resolution = resolveToolchain({
      entries: loadToolchainConfig(ALL_EXACT),
      run,
    });

    assert.throws(
      () => verifyInstalled({ resolution, run }),
      /cmake 4\.4\.5 is not installed/,
    );
  });

  it("keeps requested, resolved and installed distinct", () => {
    const provenance = describeProvenance([
      {
        tool: "deno",
        requested: "latest",
        source: "latest",
        resolved: "2.9.10",
        installed: "2.9.10",
      },
      {
        tool: "cmake",
        requested: "4.4.5",
        source: "explicit",
        resolved: "4.4.5",
        installed: "4.4.5",
      },
    ]);

    assert.deepEqual(provenance[0], {
      tool: "deno",
      requested: "latest",
      requestSource: "latest",
      resolved: "2.9.10",
      installed: "2.9.10",
    });
    assert.equal(provenance[1].requested, "4.4.5");
  });
});

/**
 * A temporary root for `toolchain:prepare --check`.
 *
 * The command reads `toolchain.toml` and `.mise.toml` from the root and records
 * provenance under `.contracts`, so a temp root exercises the real code path
 * without touching the repository.
 */
function makePrepareRoot(configText, miseText) {
  const root = mkdtempSync(path.join(os.tmpdir(), "toolchain-prepare-"));
  temporaryRoots.push(root);
  writeFileSync(path.join(root, "toolchain.toml"), configText);
  writeFileSync(path.join(root, ".mise.toml"), miseText);

  const logs = [];
  const errors = [];
  return {
    root,
    logs,
    errors,
    io: {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    },
  };
}

/** Run `toolchain:prepare --check` against a prepared root. */
function prepare(target, run) {
  return prepareMain(["--check"], target.root, target.io, run);
}

describe("projection", () => {
  it("projects only exact versions", () => {
    const toml = projectMiseToml([
      { tool: "deno", requested: "latest", resolved: "2.9.10" },
      { tool: "cmake", requested: "4.4.5", resolved: "4.4.5" },
    ]);

    assert.match(toml, /deno = "2\.9\.10"/);
    assert.match(toml, /cmake = "4\.4\.5"/);
    assert.equal(toml.includes("latest"), false);
  });

  it("refuses to project an unresolved entry", () => {
    assert.throws(
      () =>
        projectMiseToml([{
          tool: "deno",
          requested: "latest",
          resolved: null,
        }]),
      /has not been resolved/,
    );
  });

  it("is the exact projection of the shipped toolchain configuration", () => {
    const entries = loadToolchainConfig(
      readFileSync(path.join(projectRoot, "toolchain.toml"), "utf8"),
    ).map((entry) => {
      assert.equal(entry.source, "explicit", entry.tool);
      return { ...entry, resolved: entry.requested };
    });

    // Whole-file comparison: `--check` enforces this, so a comment added to one
    // file and not the other is drift, not a cosmetic difference.
    assert.equal(
      readFileSync(path.join(projectRoot, ".mise.toml"), "utf8"),
      projectMiseToml(entries),
    );
  });

  it("keeps the maintained host-tool policy inside the projection", () => {
    const toml = projectMiseToml([
      { tool: "deno", requested: "2.9.8", resolved: "2.9.8" },
    ]);

    // The policy text lives in the projection, so a `--write` cannot lose it.
    assert.match(toml, /Python is NOT project-managed/);
    assert.match(toml, /Node\.js is not used to execute any project workflow/);
    assert.match(toml, /Deno runs every task/);
    assert.match(toml, /scripts\/resolve-python\.sh/);
    assert.equal(toml.includes("python = "), false);
    assert.equal(toml.includes("node = "), false);
  });

  it("rejects a mise file that is not the projection", () => {
    const pinned = ALL_EXACT;
    const entries = loadToolchainConfig(pinned).map((entry) => ({
      ...entry,
      resolved: entry.requested,
    }));
    const { run } = makeRunner({
      installed: {
        deno: "2.9.8",
        cmake: "4.4.5",
        ninja: "1.13.2",
        emsdk: "6.0.13",
      },
    });

    const exact = makePrepareRoot(pinned, projectMiseToml(entries));
    assert.equal(prepare(exact, run), 0, exact.errors.join("\n"));

    // A comment-only difference is drift too: `--check` tests the whole
    // projection contract, not just the version numbers.
    const drifted = makePrepareRoot(
      pinned,
      `${projectMiseToml(entries)}# hand-edited note\n`,
    );
    assert.equal(prepare(drifted, run), 2, drifted.errors.join("\n"));
    assert.match(
      drifted.errors.join("\n"),
      /is not the projection of the resolved toolchain/,
    );
    assert.match(drifted.errors.join("\n"), /toolchain:prepare --write/);
  });

  it("keeps Python and Node out of the managed toolchain", () => {
    // Python is host-provided by policy. Emscripten's requirement is resolved
    // deliberately by scripts/resolve-python.sh, which provisions a fallback at
    // the requirement the installed SDK reports only when the host cannot
    // satisfy it. Listing Python here would replace that decision with a pin.
    for (const file of [".mise.toml", "toolchain.toml"]) {
      const tools = parseToolchainConfig(
        readFileSync(path.join(projectRoot, file), "utf8"),
      );

      for (const tool of ["python", "node"]) {
        assert.equal(tool in tools, false, `${file} manages ${tool}`);
      }
    }
  });
});
