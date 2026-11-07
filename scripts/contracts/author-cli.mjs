/**
 * Authoring CLI: contract refresh. Generator-only.
 *
 * `refresh` is the only operation in the project that writes the lock. It is run
 * deliberately, on the authorised platform, and its output is reviewed and
 * committed like any other source change. The generated product never receives
 * this module, so a product cannot derive or rewrite its own contract.
 */

import { canonicalJson } from "./canonical.mjs";
import { ConfigError } from "./config.mjs";
import { deriveContracts } from "./discover.mjs";
import { ContractError, SCHEMA_VERSION } from "./schema.mjs";
import {
  CONTRACT_FILE,
  documentExists,
  loadDocument,
  writeDocument,
} from "./store.mjs";
import { resolveWorkerdGraph, ToolchainError } from "./toolchain.mjs";
import { toolchainRoot } from "../lib/toolchain/runtime.mjs";
import { DiscoveryError } from "../lib/toolchain/discovery.mjs";
import { DEFAULT_VITE_PROBE_PROFILE } from "../vite-build.mjs";
import { readFileSync } from "../lib/fs.mjs";
import path from "../lib/path.mjs";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

const USAGE = `Toolchain contract authoring (generator only).

  refresh [--vite-permission-profile NAME]
      Derive every contract fact from the authorised configuration and the
      installed toolchain, then write ${CONTRACT_FILE}. Deterministic: no
      timestamps, run identifiers, host paths or approval metadata. The Vite
      target probe runs under NAME (\`local\` by default, \`ci-runner\` on a hosted
      CI runner); unknown names are rejected and nothing is inferred from the
      host.

  workerd-path
      Print the runtime selected by the Wrangler/Miniflare graph.`;

/**
 * Parse refresh arguments.
 *
 * `scripts/contract-refresh.sh` passes `--vite-permission-profile` explicitly
 * (from `VITE_PERMISSION_PROFILE`, default `local`), so this parser never has to
 * inspect the environment or guess from the host.
 */
export function parseRefreshArgs(argv) {
  const options = { vitePermissionProfile: DEFAULT_VITE_PROBE_PROFILE };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--") continue;

    if (argument === "--vite-permission-profile") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ContractError(
          "--vite-permission-profile requires a profile name",
        );
      }
      options.vitePermissionProfile = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--vite-permission-profile=")) {
      const value = argument.slice("--vite-permission-profile=".length);
      if (value.length === 0) {
        throw new ContractError(
          "--vite-permission-profile requires a profile name",
        );
      }
      options.vitePermissionProfile = value;
      continue;
    }

    throw new ContractError(
      `unknown argument ${JSON.stringify(argument)}\n\n${USAGE}`,
    );
  }

  return options;
}

/** Compare a previous lock with a freshly derived one, per scope. */
export function describeLockChanges(previous, next) {
  const changes = [];
  const before = new Map(
    Object.values(previous?.contracts ?? {}).map((contract) => [
      contract.scope,
      contract,
    ]),
  );
  const after = new Map(
    Object.values(next.contracts).map((contract) => [contract.scope, contract]),
  );

  for (const [scope, contract] of after) {
    const recorded = before.get(scope);

    if (recorded === undefined) {
      changes.push({
        scope,
        kind: "added",
        valueChanges: Object.keys(contract.values).sort(),
      });
      continue;
    }

    const valueChanges = diffValueKeys(recorded.values, contract.values);
    if (
      recorded.fingerprint === contract.fingerprint && valueChanges.length === 0
    ) {
      changes.push({ scope, kind: "unchanged", valueChanges: [] });
      continue;
    }

    changes.push({
      scope,
      kind: recorded.fingerprint === contract.fingerprint
        ? "values"
        : "fingerprint",
      valueChanges,
    });
  }

  for (const scope of before.keys()) {
    if (!after.has(scope)) {
      changes.push({ scope, kind: "removed", valueChanges: [] });
    }
  }

  return changes.sort((left, right) => left.scope.localeCompare(right.scope));
}

/** Recorded value keys whose content differs between two contracts. */
function diffValueKeys(previous = {}, next = {}) {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...keys].sort().filter((key) =>
    canonicalJson(previous[key] ?? null, 0) !==
      canonicalJson(next[key] ?? null, 0)
  );
}

/**
 * Load the previous lock for comparison, when it is comparable.
 *
 * A v1 document is not readable by this tool, and replacing it is the documented
 * migration: the new lock is reported as entirely new rather than as a diff
 * against a model that no longer exists. Anything else — an unreadable v2 file —
 * still fails loudly.
 */
function previousLock(root, io) {
  if (!documentExists(root)) return undefined;

  const file = path.join(root, CONTRACT_FILE);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ContractError(
      `${CONTRACT_FILE} is not valid JSON: ${error.message}`,
    );
  }

  if (parsed?.schemaVersion !== SCHEMA_VERSION) {
    io.log(
      `[refresh] previous lock has schemaVersion ${
        JSON.stringify(parsed?.schemaVersion)
      }; recording a fresh v${SCHEMA_VERSION} lock`,
    );
    return undefined;
  }

  return loadDocument(root);
}

/** CLI entry point; returns an exit code. */
export async function main(argv = Deno.args, root = Deno.cwd(), io = console) {
  const command = argv[0];

  if (command === "--help" || command === "-h") {
    io.log(USAGE);
    return EXIT_OK;
  }

  try {
    if (command === "workerd-path") {
      io.log(resolveWorkerdGraph(toolchainRoot()).binary);
      return EXIT_OK;
    }

    if (command === "refresh") {
      const { vitePermissionProfile } = parseRefreshArgs(argv.slice(1));
      const previous = previousLock(root, io);
      const { document } = await deriveContracts({
        root,
        io,
        vitePermissionProfile,
      });

      // Report before writing so a failure cannot leave the lock changed without
      // an explanation.
      for (const change of describeLockChanges(previous, document)) {
        const detail = change.valueChanges.length > 0
          ? ` (${change.valueChanges.join(", ")})`
          : "";
        io.log(`[refresh] ${change.scope}: ${change.kind}${detail}`);
      }

      const target = writeDocument(root, document);
      io.log(
        `[refresh] wrote ${target} with ${
          Object.keys(document.contracts).length
        } scopes`,
      );
      return EXIT_OK;
    }

    io.error(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    return EXIT_FAILURE;
  } catch (error) {
    if (
      error instanceof ContractError || error instanceof ConfigError ||
      error instanceof ToolchainError || error instanceof DiscoveryError
    ) {
      io.error(`Contract refresh failed: ${error.message}`);
      return EXIT_FAILURE;
    }
    throw error;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
