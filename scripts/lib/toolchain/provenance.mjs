/**
 * Generator provenance for a release-qualified product.
 *
 * A product's toolchain claim has two independent halves, and both are required:
 *
 *   generator implementation identity  → repository + immutable tag + full SHA
 *   accepted dependency identity       → the implementation digest
 *
 * A matching commit with the wrong dependency tree is not the accepted toolchain;
 * a matching tree produced by an unidentified or moving revision is not
 * provenance. This module enforces the first half and verifies the second.
 *
 * Nothing here creates tags, commits or releases. It only *refuses* to emit
 * release-qualified metadata unless every prerequisite already holds.
 */

import { join } from "../path.mjs";
import { readFileSync } from "../fs.mjs";

/** The approved generator repository. A fixed trust boundary, not a setting. */
export const GENERATOR_REPOSITORY = "The-Financial-Frolicker/web-ts7-vite";

/** Agreed release tag convention. */
export const RELEASE_TAG_PATTERN =
  /^toolchain-\d{4}\.(0[1-9]|1[0-2])\.([1-9]\d*)$/;

/** Product-owned provenance file. */
export const SOURCE_FILE = ".toolchain-source.json";

/** Exactly these fields; anything else is a schema violation. */
export const SOURCE_FIELDS = Object.freeze([
  "repository",
  "ref",
  "sha",
  // The portable identity of the accepted implementation: a content digest of
  // the packages mise installed. The toolchain is no longer copied into a Deno
  // tree, so there is no installed-tree fingerprint to record beside it; the
  // machine-specific view digest stays in the installation record and is never
  // published here.
  "implementation",
]);

export class ProvenanceError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProvenanceError";
  }
}

function fail(message) {
  throw new ProvenanceError(message);
}

/** Validate one metadata object and return it unchanged. */
export function validateSource(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${SOURCE_FILE} must be a JSON object`);
  }

  for (const key of Object.keys(value)) {
    if (!SOURCE_FIELDS.includes(key)) {
      fail(`${SOURCE_FILE} has unknown field ${JSON.stringify(key)}`);
    }
  }

  const { repository, ref, sha, implementation } = value;

  if (repository !== GENERATOR_REPOSITORY) {
    fail(
      `${SOURCE_FILE} names repository ${JSON.stringify(repository)}; the ` +
        `approved generator is ${JSON.stringify(GENERATOR_REPOSITORY)}`,
    );
  }
  if (typeof ref !== "string" || !RELEASE_TAG_PATTERN.test(ref)) {
    fail(
      `${SOURCE_FILE} ref ${JSON.stringify(ref)} is not a release tag of the ` +
        `form toolchain-YYYY.MM.N (month 01-12, sequence >= 1, no leading zero)`,
    );
  }
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    fail(`${SOURCE_FILE} sha must be a full 40-character commit SHA`);
  }
  if (
    typeof implementation !== "string" ||
    !/^[0-9a-f]{64}$/.test(implementation)
  ) {
    fail(`${SOURCE_FILE} implementation must be a 64-character sha256 digest`);
  }

  return value;
}

/** Parse and validate the metadata text. */
export function parseSource(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`${SOURCE_FILE} is not valid JSON: ${error.message}`);
  }
  return validateSource(parsed);
}

/** Canonical text for the metadata file. */
export function renderSource(record) {
  const ordered = Object.fromEntries(
    SOURCE_FIELDS.map((key) => [key, record[key]]),
  );
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Read and validate the metadata from a product root. */
export function readSource(productRoot) {
  let text;
  try {
    text = readFileSync(join(productRoot, SOURCE_FILE), "utf8");
  } catch (error) {
    fail(
      `no ${SOURCE_FILE} in ${productRoot} (${error.message}). This product was ` +
        `not generated with release provenance and cannot provision a toolchain ` +
        `in CI.`,
    );
  }
  return parseSource(text);
}

/** Default git runner: bounded, synchronous, no interactive paging. */
export function createGitRunner({ command = "git" } = {}) {
  const decoder = new TextDecoder();
  return (args, cwd) => {
    const output = new Deno.Command(command, {
      args: ["--no-pager", ...args],
      cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      env: { GIT_TERMINAL_PROMPT: "0" },
    }).outputSync();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  };
}

function gitOrFail(run, args, cwd, what) {
  const result = run(args, cwd);
  if (result.code !== 0) {
    fail(
      `${what} failed (git ${args.join(" ")}): ${
        (result.stderr || result.stdout).trim()
      }`,
    );
  }
  return result.stdout.trim();
}

/** 1. The generator working tree must be clean, including untracked files. */
export function requireCleanTree(root, run) {
  const status = gitOrFail(
    run,
    ["status", "--porcelain", "--untracked-files=all"],
    root,
    "git status",
  );
  if (status.length > 0) {
    fail(
      `the generator working tree is dirty, so it cannot identify a release:\n` +
        status
          .split("\n")
          .slice(0, 10)
          .map((line) => `  ${line}`)
          .join("\n"),
    );
  }
}

/**
 * 2–4. The ref must be an annotated release tag resolving to a full SHA.
 *
 * `git cat-file -t` distinguishes an annotated tag object from a lightweight tag
 * that merely points at a commit; a lightweight tag carries no release identity
 * of its own and is refused.
 */
export function resolveReleaseTag(root, ref, run) {
  if (!RELEASE_TAG_PATTERN.test(ref)) {
    fail(`ref ${JSON.stringify(ref)} is not a toolchain-YYYY.MM.N release tag`);
  }

  const kind = run(["cat-file", "-t", ref], root);
  if (kind.code !== 0) {
    fail(`release tag ${ref} does not exist in this repository`);
  }
  if (kind.stdout.trim() !== "tag") {
    fail(
      `ref ${ref} is a ${kind.stdout.trim()}, not an annotated tag; a release ` +
        `must be an annotated tag so the tag itself carries identity`,
    );
  }

  const sha = gitOrFail(
    run,
    ["rev-parse", `${ref}^{commit}`],
    root,
    `resolve ${ref}`,
  );
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    fail(
      `release tag ${ref} did not resolve to a full commit SHA (got ${sha})`,
    );
  }
  return sha;
}

/** 5. The commit being used must be exactly the selected release commit. */
export function requireHeadIs(root, sha, run) {
  const head = gitOrFail(
    run,
    ["rev-parse", "HEAD"],
    root,
    "git rev-parse HEAD",
  );
  if (head !== sha) {
    fail(
      `HEAD is ${head} but release ${sha} was selected; generation runs from ` +
        `the checked-out commit, so the two must be identical`,
    );
  }
}

/**
 * 6–7. The installed toolchain must be complete: its identity record must exist
 * and must carry well-formed specification, resolution and implementation
 * identities.
 *
 * The tree itself is **not** re-hashed here. Materialisation correctness is the
 * installer's responsibility (it digests the staging tree it has just produced
 * and writes the record from that observation before the atomic swap), and the
 * workstation is the reference environment in which that installation is
 * treated as immutable. Re-hashing it on the same machine would restate a fact
 * the installation already established, at the cost of walking the whole tree.
 *
 * The runner-side self-check that this audit used to provide is deferred to the
 * GitHub provenance workflow (see README, "Digest comparison responsibilities").
 */
export function requireInstalledIdentity(generatorInstallationRoot) {
  const file = join(generatorInstallationRoot, "toolchain.json");
  let identity;
  try {
    identity = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(
      `no valid toolchain identity at ${file} (${error.message}); provision the ` +
        `toolchain with \`deno task toolchain:install\` first`,
    );
  }

  // Schema 2 records the mise-owned toolchain: `implementation` is a content
  // digest of the installed packages, `resolution` the structure of the view
  // that resolves them, and `spec` the declaration they were installed from.
  // There is no copied tree, so there is no materialisation digest.
  if (
    typeof identity.resolution !== "string" || identity.resolution.length === 0
  ) {
    fail(`${file} records no resolution identity`);
  }
  if (typeof identity.spec !== "string" || identity.spec.length === 0) {
    fail(`${file} records no specification identity`);
  }

  if (
    typeof identity.implementation !== "string" ||
    !/^[0-9a-f]{64}$/.test(identity.implementation)
  ) {
    fail(`${file} records no implementation identity`);
  }

  return identity;
}

/**
 * Build release provenance, refusing unless every prerequisite holds.
 *
 * The published record is read from the installation's identity record: the
 * installer observed the tree when it materialised it, and this task does not
 * re-observe it. Returns the validated metadata record; writing it into the
 * product is the caller's job.
 */
export function releaseProvenance(
  { root, ref, generatorInstallationRoot, run },
) {
  requireCleanTree(root, run);
  const sha = resolveReleaseTag(root, ref, run);
  requireHeadIs(root, sha, run);
  const identity = requireInstalledIdentity(generatorInstallationRoot);

  // The installation records one content identity: there is no copied tree, so
  // there is no installed-tree state to record beside it. A value derived from
  // the machine-specific resolution view would not be portable and is never
  // published.
  return validateSource({
    repository: GENERATOR_REPOSITORY,
    ref,
    sha,
    implementation: identity.implementation,
  });
}
