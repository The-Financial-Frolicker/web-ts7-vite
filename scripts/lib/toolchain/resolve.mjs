/**
 * Resolution, installation and verification of toolchain versions.
 *
 * The `run` boundary is injected so every rule here is testable without a
 * network or a real installation. The production runner shells out to mise.
 *
 * Order is contractual: every tool is resolved before any tool is installed,
 * and installation always uses the exact resolved version.
 */

import {
  newestVersion,
  parseAvailableVersions,
  ToolchainConfigError,
} from "./versions.mjs";

function fail(message) {
  throw new ToolchainConfigError(message);
}

/** Default runner: a bounded, synchronous mise invocation. */
export function createMiseRunner({ command = "mise" } = {}) {
  const decoder = new TextDecoder();

  return (args) => {
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
  };
}

function describeFailure(args, result) {
  const detail = (result.stderr || result.stdout).trim().split("\n")[0];
  return `mise ${args.join(" ")} failed (exit ${result.code})${
    detail === "" ? "" : `: ${detail}`
  }`;
}

/**
 * Resolve every entry to an exact version.
 *
 * An explicit version must appear in the backend's list; an unresolved request
 * never falls back to another version, and an explicit version is never treated
 * as `latest`.
 */
export function resolveToolchain({ entries, run }) {
  return entries.map((entry) => {
    const args = ["ls-remote", entry.tool];
    const result = run(args);
    if (result.code !== 0) fail(describeFailure(args, result));

    const available = parseAvailableVersions(result.stdout);
    if (available.length === 0) {
      fail(`mise reported no versions for ${entry.tool}`);
    }

    if (entry.requested === "latest") {
      return { ...entry, resolved: newestVersion(available) };
    }

    if (!available.includes(entry.requested)) {
      fail(
        `requested version ${JSON.stringify(entry.requested)} for ` +
          `${entry.tool} is not available from mise`,
      );
    }

    return { ...entry, resolved: entry.requested };
  });
}

/** Install exactly the resolved versions, stopping at the first failure. */
export function installToolchain({ resolution, run, io = console }) {
  for (const entry of resolution) {
    if (entry.resolved === null) {
      fail(`refusing to install ${entry.tool}: no resolved version`);
    }

    const args = ["install", `${entry.tool}@${entry.resolved}`];
    io.log(`[toolchain] mise ${args.join(" ")}`);
    const result = run(args);
    if (result.code !== 0) fail(describeFailure(args, result));
  }

  return resolution;
}

/** Parse `mise ls --installed` into tool -> installed version. */
export function parseInstalled(output) {
  const installed = {};
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 2) continue;
    const [tool, version] = columns;
    if (/^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/.test(version)) {
      installed[tool] = version;
    }
  }

  return installed;
}

/** Verify the installed versions equal the resolved versions. */
export function verifyInstalled({ resolution, run }) {
  const args = ["ls", "--installed"];
  const result = run(args);
  if (result.code !== 0) fail(describeFailure(args, result));

  const installed = parseInstalled(result.stdout);
  const problems = [];

  for (const entry of resolution) {
    const actual = installed[entry.tool];
    if (actual === undefined) {
      problems.push(`${entry.tool} ${entry.resolved} is not installed`);
    } else if (actual !== entry.resolved) {
      problems.push(
        `${entry.tool} resolved to ${entry.resolved} but ${actual} is installed`,
      );
    }
  }

  if (problems.length > 0) fail(problems.join("; "));
  return resolution.map((entry) => ({
    ...entry,
    installed: installed[entry.tool],
  }));
}

/**
 * Provenance record: requested, resolved and installed are distinct.
 *
 * `requested` explains intent, `resolved` is the deterministic choice for this
 * run, and `installed` is what was observed afterwards.
 */
export function describeProvenance(entries) {
  return entries.map((entry) => ({
    tool: entry.tool,
    requested: entry.requested,
    requestSource: entry.source,
    resolved: entry.resolved,
    installed: entry.installed ?? null,
  }));
}
