/**
 * Product-side provenance reader and verifier (shipped with every product).
 *
 *   deno run … scripts/toolchain-source.mjs read   [--root DIR]
 *       Validate .toolchain-source.json and print shell-evaluable assignments.
 *
 *   deno run … scripts/toolchain-source.mjs verify --generator DIR [--root DIR]
 *       Require the installed toolchain to be exactly the recorded one:
 *         * the installation's own record exists and is complete;
 *         * its recorded implementation equals the product's recorded digest;
 *         * the observed implementation digest (computed with the generator's
 *           own digest implementation) equals that digest too.
 *
 * Nothing here provisions, resolves or installs. It fails closed, so a product
 * workflow can gate every later task on a single successful verification.
 */

import { join } from "./lib/path.mjs";
import { readSource } from "./lib/toolchain/provenance.mjs";
import { readFileSync } from "./lib/fs.mjs";

function fail(message) {
  throw new Error(message);
}

function argument(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

/** Print `TC_*` assignments for a shell to eval; values are validated first. */
export function read(productRoot, io, argvFormatGitHub) {
  // Validation happens once, over the whole record, before any output exists: a
  // rejected record therefore cannot leave a partially consumed interface.
  const record = readSource(productRoot);

  if (argvFormatGitHub) {
    // Structured output: exactly these three records, and nothing else, form
    // the interface later workflow steps consume. Each value is re-checked for
    // line separators, so no value can terminate a record or start a second one.
    const records = [
      ["tc_repository", record.repository],
      ["tc_ref", record.ref],
      ["tc_sha", record.sha],
    ];
    const lines = records.map(([key, value]) => {
      if (/[\r\n]/.test(value)) {
        fail(`refusing to emit a multi-line value for ${key}`);
      }
      return `${key}=${value}`;
    });
    for (const line of lines) io.log(line);
    return;
  }

  io.log(`TC_REPOSITORY=${record.repository}`);
  io.log(`TC_REF=${record.ref}`);
  io.log(`TC_SHA=${record.sha}`);
}

/**
 * Verify the installed dependencies against the product's recorded digest.
 *
 * `generatorCheckout` is the verified generator revision (the digest
 * implementation is imported from it); `generatorInstallationRoot` is the
 * generator-owned dependency tree that revision materialised.
 */
async function verify(
  productRoot,
  generatorCheckout,
  generatorInstallationRoot,
  io,
) {
  const expected = readSource(productRoot);

  // The digest algorithm belongs to the generator; import it from the checkout
  // the workflow pinned rather than duplicating it in the product.
  // The digest implementation belongs to the generator; import it from the
  // verified checkout rather than duplicating it here. The observation walks the
  // resolution view and digests the package contents it resolves — not the view
  // directory, whose symlink targets are machine-specific.
  const digestUrl = `file://${
    join(
      generatorCheckout,
      "scripts",
      "lib",
      "toolchain",
      "mise.mjs",
    )
  }`;
  const { implementationDigest, packagesFromView } = await import(digestUrl);

  const identityPath = join(generatorInstallationRoot, "toolchain.json");
  let identity;
  try {
    identity = JSON.parse(readFileSync(identityPath, "utf8"));
  } catch (error) {
    fail(`no toolchain identity at ${identityPath} (${error.message})`);
  }

  const observed = await implementationDigest(
    packagesFromView(join(generatorInstallationRoot, "node_modules")),
  );

  io.log(`provenance: ref=${expected.ref} sha=${expected.sha}`);
  io.log(`provenance: expected implementation ${expected.implementation}`);

  io.log(`installation: recorded implementation ${identity.implementation}`);
  io.log(
    `installation: observed implementation ${observed.digest} ` +
      `(${observed.packages} packages, ${observed.files} files, ${observed.bytes} bytes)`,
  );

  const problems = [];

  // Cross-machine gate: the installed implementation, without installer state.
  if (identity.implementation !== expected.implementation) {
    problems.push(
      `the installed toolchain records implementation ${identity.implementation}, ` +
        `the product expects ${expected.implementation}`,
    );
  }
  if (observed.digest !== expected.implementation) {
    problems.push(
      `the installed dependency implementation hashes to ` +
        `${observed.digest}, the product expects ${expected.implementation}`,
    );
  }

  // The recorded `resolution` identity is deliberately **not** compared here:
  // it describes the machine-specific view (symlink targets into mise's store),
  // and the runner has just built its own view. Only the portable, content-based
  // implementation digest crosses the machine boundary.
  for (const field of ["spec", "resolution"]) {
    if (typeof identity[field] !== "string" || identity[field].length === 0) {
      problems.push(`the installation record has no ${field} identity`);
    }
  }

  if (problems.length > 0) {
    fail(problems.join("; "));
  }

  io.log("provenance and implementation verified");
}

export async function main(argv = Deno.args, io = console) {
  const [command] = argv;
  const productRoot = Deno.realPathSync(argument(argv, "--root") ?? Deno.cwd());

  try {
    if (command === "read") {
      read(productRoot, io, argv.includes("--format=github"));
      return 0;
    }
    if (command === "verify") {
      const generatorCheckout = argument(argv, "--generator");
      const generatorInstallationRoot = argument(argv, "--generator-root");
      if (
        generatorCheckout === undefined ||
        generatorInstallationRoot === undefined
      ) {
        fail("verify requires --generator DIR and --generator-root DIR");
      }
      await verify(
        productRoot,
        Deno.realPathSync(generatorCheckout),
        Deno.realPathSync(generatorInstallationRoot),
        io,
      );
      return 0;
    }
    io.error(
      "usage: toolchain-source.mjs read|verify [--root DIR] [--generator DIR] [--generator-root DIR]",
    );
    return 2;
  } catch (error) {
    io.error(`toolchain provenance: ${error.message}`);
    return 1;
  }
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
