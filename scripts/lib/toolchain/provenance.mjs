/**
 * Generator provenance for a release-qualified product.
 *
 * A product's toolchain claim has two independent halves, and both are required:
 *
 *   generator implementation identity  → repository + immutable tag + full SHA
 *   accepted dependency identity       → the materialisation digest
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
  "materialisation",
  // Cross-machine identity: the installed dependency implementation, excluding
  // installer state (G8/G8a). `materialisation` is the whole-tree fingerprint,
  // which legitimately differs between machines.
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

  const { repository, ref, sha, materialisation, implementation } = value;

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
    typeof materialisation !== "string" ||
    !/^[0-9a-f]{64}$/.test(materialisation)
  ) {
    fail(`${SOURCE_FILE} materialisation must be a 64-character sha256 digest`);
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
 * 6–7. The installed toolchain must be complete and its observed tree must equal
 * the digest recorded in its own validated identity record.
 */
export async function requireInstalledIdentity(
  generatorInstallationRoot,
  digest,
) {
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

  if (
    typeof identity.materialisation !== "string" ||
    !/^[0-9a-f]{64}$/.test(identity.materialisation)
  ) {
    fail(`${file} records no materialisation digest`);
  }

  const observed = await digest(
    join(generatorInstallationRoot, "node_modules"),
  );
  if (observed.digest !== identity.materialisation) {
    fail(
      `the installed toolchain does not match its own record: recorded ` +
        `${identity.materialisation}, observed ${observed.digest}. Re-provision ` +
        `before emitting release provenance.`,
    );
  }

  // The cross-machine identity must also agree with the same observation. The
  // whole-tree fingerprint above is a same-machine check; this one is the value
  // a product records and another machine reproduces.
  if (
    typeof identity.implementation !== "string" ||
    !/^[0-9a-f]{64}$/.test(identity.implementation)
  ) {
    fail(`${file} records no implementation identity`);
  }
  if (observed.implementationDigest !== identity.implementation) {
    fail(
      `the installed toolchain does not match its recorded implementation: ` +
        `recorded ${identity.implementation}, observed ` +
        `${observed.implementationDigest}. Re-provision before emitting release provenance.`,
    );
  }

  return { identity, observed };
}

/**
 * Build release provenance, refusing unless every prerequisite holds.
 *
 * Returns the validated metadata record; writing it into the product is the
 * caller's job.
 */
export async function releaseProvenance(
  { root, ref, generatorInstallationRoot, run, digest },
) {
  requireCleanTree(root, run);
  const sha = resolveReleaseTag(root, ref, run);
  requireHeadIs(root, sha, run);
  const { identity } = await requireInstalledIdentity(
    generatorInstallationRoot,
    digest,
  );

  return validateSource({
    repository: GENERATOR_REPOSITORY,
    ref,
    sha,
    materialisation: identity.materialisation,
    implementation: identity.implementation,
  });
}
