/**
 * Structural invariants of the specified-toolchain architecture.
 *
 * These assertions are about execution paths and about what the repository
 * contains, not about wording:
 *
 *   * the generator never invokes `mise install` itself (one installation step,
 *     performed by the operator or by CI's mise action);
 *   * the dependency installer performs no tool installation and mutates no
 *     installed toolchain;
 *   * the machinery that existed only to manage toolchain transitions is gone,
 *     not renamed.
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
import { run } from "./lib/command.mjs";
import { after, describe, it } from "./lib/test.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(prefix) {
  const root = Deno.realPathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

/** Repository sources that could carry an installation invocation. */
function executableSources() {
  const files = [];
  for (const entry of Deno.readDirSync(path.join(projectRoot, "scripts"))) {
    if (entry.isDirectory) continue;
    if (entry.name.endsWith(".mjs") || entry.name.endsWith(".sh")) {
      files.push(path.join("scripts", entry.name));
    }
  }
  const workflows = path.join(projectRoot, ".github", "workflows");
  for (const entry of Deno.readDirSync(workflows)) {
    files.push(path.join(".github", "workflows", entry.name));
  }
  return files;
}

describe("installation is performed once, by mise, outside the generator", () => {
  it("no project script or task invokes `mise install`", () => {
    const offenders = [];

    /** True when the offset sits inside a double-quoted string literal. */
    function insideString(line, offset) {
      let quotes = 0;
      for (let index = 0; index < offset; index += 1) {
        if (line[index] === '"' && line[index - 1] !== "\\") quotes += 1;
      }
      return quotes % 2 === 1;
    }

    for (const relative of executableSources()) {
      const text = readFileSync(path.join(projectRoot, relative), "utf8");
      text.split("\n").forEach((line, index) => {
        const trimmed = line.trimStart();
        // Comments and doc comments are documentation, not execution.
        if (
          trimmed.startsWith("#") || trimmed.startsWith("*") ||
          trimmed.startsWith("//")
        ) {
          return;
        }

        const pattern = /(?:^|[;&|(]|\$\()\s*mise\s+install\b/g;
        for (const match of line.matchAll(pattern)) {
          // Operator guidance printed by a script is not an invocation.
          if (insideString(line, match.index + match[0].length - 1)) continue;
          // The host-Python fallback provisions an interpreter, not a specified
          // toolchain version: Emscripten's python is a host prerequisite.
          if (relative === "scripts/resolve-python.sh") continue;
          offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("the tasks expose no preparation or projection step", () => {
    const tasks = JSON.parse(
      readFileSync(path.join(projectRoot, "deno.json"), "utf8"),
    ).tasks;
    for (const retired of ["toolchain:prepare", "test:toolchain-config"]) {
      assert.equal(retired in tasks, false, `${retired} must be gone`);
    }
    assert.ok("toolchain:specify" in tasks, "explicit specification exists");
    assert.ok("toolchain:install" in tasks, "dependency installation exists");
  });

  it("the transition machinery is removed, not bypassed", () => {
    for (
      const retired of [
        "toolchain.toml",
        "scripts/toolchain-prepare.mjs",
        "scripts/lib/toolchain/versions.mjs",
        "scripts/lib/toolchain/resolve.mjs",
        "scripts/toolchain-config.test.mjs",
      ]
    ) {
      assert.equal(
        existsSync(path.join(projectRoot, retired)),
        false,
        `${retired} must not exist`,
      );
    }
  });
});

/** Run the installer in plan mode and return the parsed plan. */
function plan(env) {
  const result = run(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      "--allow-run",
      "--allow-write",
      path.join(projectRoot, "scripts", "toolchain-install.mjs"),
      "--print",
    ],
    cwd: projectRoot,
    env,
  });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
}

describe("the dependency installer installs no tools and mutates nothing", () => {
  it("performs zero mise invocations, even with a mise stub on PATH", () => {
    const root = makeRoot("no-mise-");
    const stub = path.join(root, "stub");
    const marker = path.join(root, "mise-was-invoked");
    mkdirSync(stub, { recursive: true });
    writeFileSync(
      path.join(stub, "mise"),
      `#!/usr/bin/env bash\necho "mise $*" >> "${marker}"\nexit 0\n`,
    );
    Deno.chmodSync(path.join(stub, "mise"), 0o755);

    const planned = plan({ PATH: `${stub}:${Deno.env.get("PATH") ?? ""}` });

    assert.equal(existsSync(marker), false, "mise must not be invoked");
    assert.match(planned.target, /generator\/dependencies$/);
    assert.equal(existsSync(planned.staging), false, "no staging is created");
    assert.equal(existsSync(planned.previous), false, "no swap is performed");
  });

  it("leaves the installed toolchain byte-identical across inspections", () => {
    const first = plan();
    const files = ["toolchain.json", "package.json", "deno.json", "deno.lock"];
    const before = files.map((name) =>
      Deno.readFileSync(path.join(first.target, name))
    );

    const second = plan();
    assert.equal(second.target, first.target);

    files.forEach((name, index) => {
      assert.deepEqual(
        Deno.readFileSync(path.join(second.target, name)),
        before[index],
        `${name} must be untouched`,
      );
    });
  });
});
