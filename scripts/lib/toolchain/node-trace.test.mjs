/**
 * Trace-backed evidence for the No-Node guarantee.
 *
 * Parser/classifier cases use synthetic trace records; the final case traces a
 * real protected operation. Detection only: this proves what executed, it does
 * not prevent anything.
 */
import assert from "../assert.mjs";
import { describe, it } from "../test.mjs";
import {
  classifyExecution,
  formatViolation,
  looksLikeNode,
  miseDataDirectory,
  parseExecutions,
  permittedEmscriptenNode,
  prohibitedExecutions,
  straceAvailable,
  traceCommand,
} from "./node-trace.mjs";

const synthetic = [
  '100 execve("/usr/bin/deno", ["deno", "task"], 0x7f /* 58 vars */) = 0',
  '101 execve("/usr/bin/node", ["node", "-e", "0"], 0x7f /* 58 vars */) = 0',
  '102 execve("/tmp/deno-no-node.ijaVeC/node", ["node", "-e", "0"], 0x7f) = 0',
  '103 execve("/usr/local/bin/node", ["node"], 0x7f) = -1 ENOENT (No such file or directory)',
  '104 execve("/usr/bin/bash", ["bash", "-c", "node -e 0"], 0x7f) = 0',
  '105 execveat(3, "/opt/tools/node", ["node", "--version"], 0, AT_SYMLINK_NOFOLLOW) = 0',
].join("\n");

describe("trace parsing", () => {
  it("reads execve and execveat, successes and failures", () => {
    const parsed = parseExecutions(synthetic);
    assert.equal(parsed.length, 6);
    assert.equal(parsed[0].path, "/usr/bin/deno");
    assert.equal(parsed[0].ok, true);
    assert.equal(parsed[3].path, "/usr/local/bin/node");
    assert.equal(parsed[3].ok, false, "a failed lookup is not an execution");
    assert.equal(parsed[5].path, "/opt/tools/node", "execveat path is read");
  });

  it("ignores lines that are not executions", () => {
    assert.deepEqual(
      parseExecutions('--- SIGCHLD ---\nwrite(1, "node", 4) = 4'),
      [],
    );
  });
});

describe("execution classification", () => {
  const executions = parseExecutions(synthetic);
  const permitted = "/mise/emsdk/6.0.13/node/24.19.0_64bit/bin/node";

  it("classifies a normal executable as other", () => {
    assert.equal(classifyExecution(executions[0], { permitted }), "other");
  });

  it("classifies a real Node runtime as a violation", () => {
    assert.equal(classifyExecution(executions[1], { permitted }), "node");
  });

  it("does not mistake the PATH tripwire shim for Node", () => {
    // Same argv as a Node invocation; a different executable.
    assert.equal(executions[2].argv[0], "node");
    assert.equal(
      classifyExecution(executions[2], { permitted }),
      "tripwire-shim",
    );
  });

  it("does not treat a failed lookup as execution", () => {
    assert.equal(classifyExecution(executions[3], { permitted }), "other");
  });

  it("does not treat argv text as the executable", () => {
    assert.equal(executions[4].path, "/usr/bin/bash");
    assert.equal(classifyExecution(executions[4], { permitted }), "other");
  });

  it("permits only the exact Emscripten-runtime path", () => {
    const emscripten = { path: permitted, argv: ["node", "-v"], ok: true };
    assert.equal(
      classifyExecution(emscripten, { permitted }),
      "permitted-emscripten",
    );
    // The same runtime elsewhere, or any other node, stays a violation.
    assert.equal(classifyExecution(emscripten, { permitted: null }), "node");
    assert.equal(
      classifyExecution({ ...emscripten, path: "/mise/emsdk/other/bin/node" }, {
        permitted,
      }),
      "node",
    );
  });

  it("reports violations with path and argv", () => {
    const hits = prohibitedExecutions(synthetic, { permitted });
    assert.equal(hits.length, 2, "/usr/bin/node and /opt/tools/node");
    assert.match(
      formatViolation(hits[0]),
      /Node runtime executed as host: \/usr\/bin\/node/,
    );
  });

  it("recognises Node runtimes by executable name only", () => {
    assert.equal(looksLikeNode("/x/bin/node"), true);
    assert.equal(looksLikeNode("/x/bin/nodejs"), true);
    assert.equal(looksLikeNode("/x/bin/nodemon"), false);
    assert.equal(looksLikeNode("/x/bin/deno"), false);
  });
});

describe("the permitted Emscripten runtime", () => {
  it("is derived from the mise installation, not a hard-coded home", () => {
    const permitted = permittedEmscriptenNode();
    if (permitted === null) return; // no SDK installed: nothing to bind
    assert.ok(permitted.startsWith(miseDataDirectory()));
    assert.match(permitted, /emsdk\/[^/]+\/node\/[^/]+\/bin\/node$/);
    assert.equal(Deno.realPathSync(permitted), permitted);
  });
});

describe("a real protected operation", () => {
  it("executes no Node runtime as host", () => {
    if (!straceAvailable()) {
      console.log(
        "process-trace assertion NOT performed: strace is unavailable",
      );
      return;
    }

    const permitted = permittedEmscriptenNode();
    const result = traceCommand(["deno", "task", "check:client"], {
      cwd: Deno.cwd(),
    });

    assert.equal(
      result.code,
      0,
      `check:client failed: ${result.stderr.slice(0, 400)}`,
    );
    const executions = parseExecutions(result.trace);
    assert.ok(executions.length > 0, "the trace must contain executions");

    const hits = prohibitedExecutions(result.trace, { permitted });
    assert.deepEqual(
      hits.map((entry) => entry.path),
      [],
      hits.map(formatViolation).join("\n"),
    );
  });
});
