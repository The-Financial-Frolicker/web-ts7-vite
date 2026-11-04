/**
 * Product-side contract CLI: verify, status, show and accept.
 *
 * This module ships in the generated product. It deliberately contains no
 * discovery or approval code: a product can enforce its inherited contract and
 * accept a new *already approved* artefact, but it cannot investigate a
 * toolchain or manufacture an approval.
 */

import { canonicalJson } from "./canonical.mjs";
import { ConfigError } from "./config.mjs";
import {
  ContractError,
  unapprovedContracts,
  validateDocument,
} from "./schema.mjs";
import { loadDocument, summarise, writeDocument } from "./store.mjs";
import { ToolchainError } from "./toolchain.mjs";
import { verifyContracts } from "./verify.mjs";
import { readFileSync } from "../lib/fs.mjs";
import path from "../lib/path.mjs";

const EXIT_OK = 0;
const EXIT_FAILURE = 1;

const USAGE = `Toolchain contract consumption.

  verify
      Verify the installed toolchain and configuration against the contract.
      Performs no discovery and starts no external tool.

  status
      Print each contract's lifecycle state; exits non-zero while any contract
      still needs a human decision.

  show
      Print the committed artefact.

  accept --from FILE
      Install an already-approved contract artefact. Refuses candidates and
      bootstrap baselines: acceptance is not approval.`;

const FLAGS = new Map([["--from", "from"]]);

function parseArgs(argv) {
  const options = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
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

async function runVerify(root, io) {
  const { problems, notes } = await verifyContracts(root);

  for (const note of notes) io.log(`[verify] ${note}`);

  if (problems.length > 0) {
    io.error("Toolchain contracts are not satisfied:");
    for (const problem of problems) io.error(`  - ${problem}`);
    return EXIT_FAILURE;
  }

  io.log(
    "Toolchain contracts OK: the installed toolchain and configuration match " +
      "the approved contract.",
  );
  return EXIT_OK;
}

function runStatus(root, io) {
  const document = loadDocument(root);

  for (const entry of summarise(document)) {
    io.log(`${entry.scope} ${entry.key.split("@").at(-1)} ${entry.state}`);
  }

  const pending = unapprovedContracts(document);
  if (pending.length > 0) {
    io.error(
      `${pending.length} contract(s) require an explicit human approval ` +
        `decision before CI can accept them: ${pending.join(", ")}`,
    );
    return EXIT_FAILURE;
  }

  io.log("Every contract carries an approval bound to its fingerprint.");
  return EXIT_OK;
}

function runShow(root, io) {
  const document = loadDocument(root);
  io.log(
    canonicalJson({
      toolchain: document.toolchain,
      contracts: summarise(document),
      policies: document.policies,
    }),
  );
  return EXIT_OK;
}

/**
 * Install an approved artefact supplied from outside the product.
 *
 * This is the product's upgrade path for a *contract*: a new approved baseline
 * arrives as a file and is installed verbatim. It cannot promote a candidate or
 * a bootstrap baseline, so it can never manufacture an approval.
 */
function runAccept(root, options, io) {
  if (typeof options.from !== "string") {
    throw new ContractError("accept requires --from FILE");
  }

  const source = path.isAbsolute(options.from)
    ? options.from
    : path.join(root, options.from);

  let incoming;
  try {
    incoming = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new ContractError(`cannot read ${source}: ${error.message}`);
  }

  validateDocument(incoming);

  const notApproved = unapprovedContracts(incoming);
  if (notApproved.length > 0) {
    throw new ContractError(
      `refusing to accept ${source}: ${notApproved.length} contract(s) are not ` +
        `approved (${
          notApproved.join(", ")
        }). Acceptance installs an existing ` +
        `human approval; it never creates one.`,
    );
  }

  const target = writeDocument(root, incoming);
  io.log(`Accepted approved contract from ${source}.`);
  io.log(`Written to ${target}.`);
  io.log("Run `deno task check:contracts` to verify this product against it.");
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
      case "verify":
        return await runVerify(root, io);
      case "status":
        return runStatus(root, io);
      case "show":
        return runShow(root, io);
      case "accept":
        return runAccept(root, options, io);
      default:
        io.error(
          `unknown command ${JSON.stringify(options.command)}\n\n${USAGE}`,
        );
        return EXIT_FAILURE;
    }
  } catch (error) {
    if (
      error instanceof ContractError || error instanceof ToolchainError ||
      error instanceof ConfigError
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
