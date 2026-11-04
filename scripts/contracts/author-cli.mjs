/**
 * Authoring CLI: discovery and approval. Generator-only.
 *
 * The generated product receives `cli.mjs` (verify/status/show/accept) and
 * never this module, so a product has no code path that can discover or
 * approve a contract.
 */

import { approveCandidate } from "./approve.mjs";
import { ConfigError } from "./config.mjs";
import { discoverContracts } from "./discover.mjs";
import {
  ContractError,
  unverifiedValues,
  validateDocument,
} from "./schema.mjs";
import {
  CANDIDATE_FILE,
  documentExists,
  loadDocument,
  summarise,
  writeDocument,
} from "./store.mjs";
import { resolveWorkerdGraph, ToolchainError } from "./toolchain.mjs";
import { DiscoveryError } from "../lib/toolchain/discovery.mjs";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_UNCERTAIN = 2;

const USAGE = `Toolchain contract authoring (generator only).

  discover [--timeout MS]
      Probe the installed toolchain and write ${CANDIDATE_FILE}. Exits 2 when a
      value could not be established. Never approves anything.

  approve --by NAME --reason TEXT [--client-api-edition EDITION] [--replace] [--reaffirm]
      Record an explicit human approval of the candidate. Without --reaffirm,
      existing policies are carried forward unchanged.

  workerd-path
      Print the runtime selected by the Wrangler/Miniflare graph.`;

const FLAGS = new Map([
  ["--by", "by"],
  ["--reason", "reason"],
  ["--client-api-edition", "clientApiEdition"],
  ["--timeout", "timeout"],
]);

function parseArgs(argv) {
  const options = { command: argv[0], replace: false, reaffirm: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--replace") {
      options.replace = true;
      continue;
    }
    if (argument === "--reaffirm") {
      options.reaffirm = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    const name = FLAGS.get(argument);
    if (name === undefined) {
      throw new ContractError(
        `unknown argument ${JSON.stringify(argument)}\n\n${USAGE}`,
      );
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ContractError(`${argument} requires a value`);
    }
    options[name] = value;
    index += 1;
  }

  return options;
}

async function runDiscover(root, options, io) {
  const timeout = options.timeout === undefined
    ? 25_000
    : Number(options.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new ContractError(
      "--timeout must be a positive number of milliseconds",
    );
  }

  const { document, diagnostics } = await discoverContracts({
    root,
    io,
    probeTimeoutMs: timeout,
  });

  writeDocument(root, document, CANDIDATE_FILE);
  for (const diagnostic of diagnostics) io.error(`[discover] ${diagnostic}`);

  const uncertain = Object.values(document.contracts)
    .flatMap((contract) => unverifiedValues(contract));

  io.log(`Candidate written to ${CANDIDATE_FILE}.`);
  for (const key of Object.keys(document.contracts)) io.log(`  ${key}`);

  if (uncertain.length > 0) {
    io.error(
      `Discovery is inconclusive: ${uncertain.length} value(s) could not be ` +
        `established (${
          uncertain.join(", ")
        }). The candidate cannot be approved.`,
    );
    return EXIT_UNCERTAIN;
  }

  io.log(
    `Next: deno task contract:approve -- --by "Your Name" --reason "..." ` +
      `--client-api-edition <edition>`,
  );
  return EXIT_OK;
}

function runApprove(root, options, io) {
  const candidate = loadDocument(root, CANDIDATE_FILE);
  const existing = documentExists(root)
    ? loadDocument(root)
    : { schemaVersion: 1, toolchain: {}, contracts: {}, policies: {} };

  const document = approveCandidate({
    existing,
    candidate,
    by: options.by,
    reason: options.reason,
    at: new Date().toISOString(),
    replace: options.replace,
    reaffirm: options.reaffirm,
    clientApiEdition: options.clientApiEdition,
    root,
  });

  validateDocument(document);
  const target = writeDocument(root, document);
  io.log(`Approved contract written to ${target}.`);

  for (const entry of summarise(document)) {
    io.log(`  ${entry.key} ${entry.state}`);
  }
  io.log("Review the file, then commit it.");
  return EXIT_OK;
}

function runWorkerdPath(root, io) {
  io.log(resolveWorkerdGraph(root).binary);
  return EXIT_OK;
}

/** CLI entry point; returns an exit code instead of exiting directly. */
export async function main(argv = Deno.args, root = Deno.cwd(), io = console) {
  try {
    const options = parseArgs(argv);

    if (options.help || options.command === undefined) {
      io.log(USAGE);
      return options.command === undefined && !options.help
        ? EXIT_FAILURE
        : EXIT_OK;
    }

    switch (options.command) {
      case "discover":
        return await runDiscover(root, options, io);
      case "approve":
        return runApprove(root, options, io);
      case "workerd-path":
        return runWorkerdPath(root, io);
      default:
        io.error(
          `unknown command ${JSON.stringify(options.command)}\n\n${USAGE}`,
        );
        return EXIT_FAILURE;
    }
  } catch (error) {
    if (
      error instanceof ContractError || error instanceof ToolchainError ||
      error instanceof ConfigError || error instanceof DiscoveryError
    ) {
      io.error(`Error: ${error.message}`);
      return EXIT_FAILURE;
    }
    throw error;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
