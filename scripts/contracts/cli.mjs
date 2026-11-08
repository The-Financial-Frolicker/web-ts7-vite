/**
 * Product-side contract CLI: verify, status and show.
 *
 * This module ships in the generated product and has no refresh capability and
 * no authoring code path: a product can establish whether the environment still
 * conforms to the lock it inherited, and can display that lock.
 *
 * `verify` prints a machine-readable conformance report on stdout and human
 * diagnostics on stderr. The report is produced even when verification fails.
 */

import { canonicalJson } from "./canonical.mjs";
import { ConfigError } from "./config.mjs";
import { ContractError } from "./schema.mjs";
import { loadDocument, summarise } from "./store.mjs";
import { ToolchainError } from "./toolchain.mjs";
import { summariseScope, verifyContracts } from "./verify.mjs";
import { generatorInstallationRoot } from "../lib/toolchain/runtime.mjs";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

const USAGE = `Toolchain contract consumption.

  verify
      Recompute the contract facts and compare them with the committed lock.
      Prints the conformance report (JSON) on stdout and diagnostics on stderr.
      Performs no discovery and starts no external tool.

  status
      Print one line per scope: recorded, drifted or unrecorded. Exits non-zero
      unless every scope is recorded.

  show
      Print the committed lock.`;

function parseArgs(argv) {
  const options = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    throw new ContractError(
      `unknown argument ${JSON.stringify(argument)}\n\n${USAGE}`,
    );
  }

  return options;
}

async function runVerify(root, io) {
  const { report, notes } = await verifyContracts(
    root,
    generatorInstallationRoot(),
  );

  for (const note of notes) io.error(`[verify] ${note}`);
  for (const entry of report.scopes) {
    io.error(`[verify] ${summariseScope(entry)}`);
  }

  // The report is emitted whether or not the verdict is conformant, so a failing
  // run still leaves machine-readable evidence.
  io.log(canonicalJson(report));

  if (report.verdict === "conformant") {
    io.error(
      "Conformance OK: the environment matches the committed contract lock.",
    );
    return EXIT_OK;
  }

  io.error("Contract conformance failed:");
  for (const problem of report.problems) io.error(`  - ${problem}`);
  return EXIT_FAILURE;
}

async function runStatus(root, io) {
  const { report } = await verifyContracts(root, generatorInstallationRoot());

  for (const entry of report.scopes) io.log(summariseScope(entry));

  return report.verdict === "conformant" ? EXIT_OK : EXIT_FAILURE;
}

function runShow(root, io) {
  io.log(canonicalJson(loadDocument(root)));
  return EXIT_OK;
}

/** CLI entry point; returns an exit code. */
export async function main(argv = Deno.args, root = Deno.cwd(), io = console) {
  try {
    const options = parseArgs(argv);

    if (options.help === true) {
      io.log(USAGE);
      return EXIT_OK;
    }

    switch (options.command) {
      case "verify":
        return await runVerify(root, io);
      case "status":
        return await runStatus(root, io);
      case "show":
        return runShow(root, io);
      default:
        io.error(
          `unknown command ${JSON.stringify(options.command)}\n\n${USAGE}`,
        );
        return EXIT_FAILURE;
    }
  } catch (error) {
    if (
      error instanceof ContractError || error instanceof ConfigError ||
      error instanceof ToolchainError
    ) {
      io.error(`Contract verification failed: ${error.message}`);
      return EXIT_FAILURE;
    }
    throw error;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}

/** Re-exported for callers that only need the lock summary. */
export { summarise };
