/**
 * Tests for the Node-exclusion PATH tripwire.
 *
 * These tests verify command-name rejection, argument and exit propagation,
 * legitimate tool availability, parent-environment isolation and operation when
 * Node is absent entirely.
 */

import assert from "./lib/assert.mjs";
import { describe, it } from "./lib/test.mjs";
import { join } from "./lib/path.mjs";

const wrapper = join(Deno.cwd(), "scripts", "deno-no-node.sh");

/**
 * A complete environment for the wrapper.
 *
 * `clearEnv` plus an explicit environment keeps each case hermetic: without it,
 * the suite itself runs under the tripwire, so an inherited
 * `DENO_NO_NODE_ACTIVE` would silently skip the wrapper in every child.
 */
function baseEnv() {
  return {
    HOME: Deno.env.get("HOME") ?? "/tmp",
    TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  };
}

function runWrapper(args, env) {
  return new Deno.Command("bash", {
    args: [wrapper, ...args],
    env: env ?? baseEnv(),
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
}

function decode(bytes) {
  return new TextDecoder().decode(bytes);
}

describe("deno-no-node wrapper", () => {
  it("runs a normal Deno task", () => {
    const result = runWrapper(["deno", "eval", 'console.log("tripwire-ok")']);

    assert.equal(result.code, 0);
    assert.match(decode(result.stdout), /tripwire-ok/);
  });

  it("rejects node by name with a clear diagnostic", () => {
    const result = runWrapper(["sh", "-c", "node --version"]);

    assert.equal(result.code, 127);
    assert.match(decode(result.stderr), /Node\.js is excluded/);
    assert.match(decode(result.stderr), /node/);
  });

  it("propagates arguments and exit statuses", () => {
    const args = runWrapper([
      "sh",
      "-c",
      'printf "%s|%s\\n" "$1" "$2"',
      "sh",
      "a b",
      "c",
    ]);
    assert.equal(args.code, 0);
    assert.equal(decode(args.stdout), "a b|c\n");

    const failure = runWrapper(["sh", "-c", "exit 7"]);
    assert.equal(failure.code, 7);
  });

  it("leaves legitimate tools available and does not alter the parent PATH", () => {
    const before = Deno.env.get("PATH");
    const result = runWrapper([
      "sh",
      "-c",
      "command -v deno >/dev/null && command -v git >/dev/null && " +
      "command -v bash >/dev/null && echo tools-ok",
    ]);

    assert.equal(result.code, 0);
    assert.match(decode(result.stdout), /tools-ok/);
    assert.equal(Deno.env.get("PATH"), before);
  });

  it("stays a single tripwire when the wrapper is entered twice", () => {
    const result = runWrapper([wrapper, "sh", "-c", "node --version"]);

    assert.equal(result.code, 127);
    assert.match(decode(result.stderr), /Node\.js is excluded/);
  });

  it("treats the recursion marker as a guard, not an unforgeable token", () => {
    // Documents the boundary: the marker prevents nested tripwires, so a caller
    // that sets it deliberately opts out. It is not a security token.
    const result = runWrapper(["sh", "-c", "echo marker-ok"], {
      ...Deno.env.toObject(),
      DENO_NO_NODE_ACTIVE: "1",
    });

    assert.equal(result.code, 0);
    assert.match(decode(result.stdout), /marker-ok/);
    assert.doesNotMatch(decode(result.stderr), /Node\.js is excluded/);
  });

  it("works when Node is absent from PATH", () => {
    const bin = Deno.makeTempDirSync({ prefix: "deno-no-node-test-" });
    try {
      for (
        const [name, target] of [
          ["sh", "/bin/sh"],
          ["bash", "/bin/bash"],
          ["mktemp", "/usr/bin/mktemp"],
          ["rm", "/usr/bin/rm"],
          ["chmod", "/usr/bin/chmod"],
        ]
      ) {
        Deno.symlinkSync(target, join(bin, name));
      }

      const env = {
        HOME: Deno.env.get("HOME") ?? "/tmp",
        TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
        PATH: bin,
      };
      const result = runWrapper(["sh", "-c", "echo node-free-ok"], env);
      assert.equal(result.code, 0);
      assert.match(decode(result.stdout), /node-free-ok/);

      const node = runWrapper(["sh", "-c", "node --version"], env);
      assert.equal(node.code, 127);
      assert.match(decode(node.stderr), /Node\.js is excluded/);
    } finally {
      Deno.removeSync(bin, { recursive: true });
    }
  });
});

describe("protected-domain enforcement (promoted invariant)", () => {
  // The wrapper is a command-name exclusion. These cases establish what it does
  // reject, what it cannot see, and that Node's mere presence is not a breach.
  const repo = Deno.cwd();
  const wrapper = `${repo}/scripts/deno-no-node.sh`;

  function outsideTripwire() {
    const env = Deno.env.toObject();
    delete env.DENO_NO_NODE_ACTIVE; // the suite itself runs one tripwire deep
    return env;
  }

  function run(command) {
    return new Deno.Command("bash", {
      args: [wrapper, ...command],
      cwd: repo,
      env: outsideTripwire(),
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
    }).outputSync();
  }

  it("rejects a direct invocation by executable name", () => {
    const result = run(["node", "-e", "0"]);
    assert.equal(result.code, 127);
    assert.match(
      new TextDecoder().decode(result.stderr),
      /Node\.js is excluded from project-owned execution/,
    );
  });

  it("rejects an indirect invocation through a shell", () => {
    const result = run(["bash", "-c", "node -e 0"]);
    assert.equal(result.code, 127);
    assert.match(
      new TextDecoder().decode(result.stderr),
      /excluded from project-owned execution/,
    );
  });

  it("rejects a shebang that resolves node through PATH", () => {
    const directory = Deno.makeTempDirSync({ prefix: "no-node-shebang-" });
    try {
      const script = `${directory}/tool`;
      Deno.writeTextFileSync(
        script,
        "#!/usr/bin/env node\nconsole.log('hosted by node');\n",
      );
      Deno.chmodSync(script, 0o755);
      const result = run([script]);
      assert.equal(result.code, 127, "the shebang must not find node");
    } finally {
      Deno.removeSync(directory, { recursive: true });
    }
  });

  it("states its own scope, so the guarantee cannot drift wider than the code", () => {
    // The observed behaviour of an absolute path is not uniform: a real binary
    // ignores PATH entirely, while a launcher such as a mise shim still resolves
    // through PATH and is caught. Because the outcome depends on what the
    // absolute path is, the contract is held in the wrapper's own header rather
    // than asserted here as a guarantee the mechanism cannot keep.
    const header = Deno.readTextFileSync(`${repo}/scripts/deno-no-node.sh`);
    assert.match(header, /command-name exclusion, not an OS process sandbox/);
    assert.match(header, /absolute path such as \/usr\/bin\/node/);
    assert.match(header, /outside its reach/);
  });

  it("permits Node to be installed and available", () => {
    // Presence is not execution: Deno-hosted protected work must still run, and
    // no installation may be pruned to make the guarantee look stronger.
    const result = run([
      "deno",
      "eval",
      "console.log('protected operation ran')",
    ]);
    assert.equal(result.code, 0);
    assert.match(
      new TextDecoder().decode(result.stdout),
      /protected operation ran/,
    );
  });

  it("leaves deployment integration outside the prohibition", () => {
    const tasks = JSON.parse(Deno.readTextFileSync(`${repo}/deno.json`)).tasks;

    // Deployment itself is not wrapped: Node is permitted there, and a
    // deployment run can never be reported as a build-toolchain breach.
    assert.equal(tasks.deploy.includes("deno-no-node.sh"), false);

    // The protected build domain is wrapped.
    for (const name of ["build", "validate", "check:client", "test:scripts"]) {
      assert.ok(
        tasks[name].includes("deno-no-node.sh"),
        `${name} is protected and must run under the tripwire`,
      );
    }

    // Known overlap, recorded rather than silently reclassified: the dry-run task
    // also performs the build, so it currently runs under the tripwire. Separating
    // the two phases belongs to the build/deployment lifecycle work, not here.
    assert.ok(tasks["deploy:dry-run"].includes("deno-no-node.sh"));
  });
});
