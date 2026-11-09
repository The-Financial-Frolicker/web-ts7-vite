/**
 * The build → deployment hand-off.
 *
 * `deno task build` writes the deployable tree to `dist/`. This module turns that
 * tree into a self-describing hand-off and verifies one at the deployment
 * boundary:
 *
 *   deno task artefact:pack     build side: copy `dist/` into a hand-off
 *                               directory and write its manifest
 *   deno task artefact:verify   deployment side: re-hash the received `dist/`
 *                               and refuse anything that is not the payload the
 *                               manifest describes
 *
 * The manifest is not a certificate and carries no signature. The digest proves
 * **payload integrity** — that the tree the deployment received is byte for byte
 * the tree the build produced — and nothing about who produced it. Authenticity
 * is the repository's existing provenance (`toolchain.json`, `.toolchain-source
 * .json`, the commit and the workflow identity); this record only adds the one
 * fact those mechanisms do not state: which payload belongs to which build.
 *
 * What the record contains is deliberately limited to facts the build already
 * knows and already publishes:
 *
 *   * the build identity compiled into the delivered page (`src/build-identity
 *     .ts`, written by `scripts/build.sh` from `BUILD_SHA`/`BUILD_DEPLOYMENT`);
 *   * the pinned toolchain tuple from the project's own `.mise.toml`;
 *   * the generated Worker name (`package.json`), which is the *build* identity.
 *     A deployment may still deploy this payload under another name with
 *     `wrangler deploy --name`; the record then explains which build it used;
 *   * one sha256 per payload file plus an aggregate digest over the file list.
 *
 * Hidden files are part of the payload. `dist/client/.assetsignore` is written by
 * the Cloudflare Vite plugin and steers which files Wrangler uploads as assets,
 * so a transfer that silently dropped dotfiles would change the deployed
 * artefact. The walk below includes them, and the digest therefore covers them.
 *
 * Exit codes: 0 success, 1 a check failed, 2 usage error.
 */

import { join } from "./lib/path.mjs";
import { readFileSync } from "./lib/fs.mjs";

/** The hand-off record, written beside the payload directory. */
export const MANIFEST_FILE = "artefact-manifest.json";

/** The payload directory, relative to the project (and hand-off) root. */
export const PAYLOAD_DIR = "dist";

/** The record format this module writes and accepts. */
export const MANIFEST_SCHEMA = 1;

/**
 * Files the deployment path reads. A hand-off missing any of them cannot be
 * deployed, so packing refuses and verification refuses, at the earliest
 * possible point rather than inside Wrangler.
 */
export const REQUIRED_FILES = Object.freeze([
  "worker/wrangler.json",
  "worker/index.js",
  "client/index.html",
]);

/** Source map companion, required while the generated config uploads maps. */
export const WORKER_SOURCE_MAP = "worker/index.js.map";
export const GENERATED_CONFIG = "worker/wrangler.json";

export class ArtefactError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtefactError";
  }
}

function fail(message) {
  throw new ArtefactError(message);
}

/** sha256 of a byte string, as lowercase hex. */
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Every regular file under `directory`, as sorted POSIX paths relative to it.
 *
 * Symbolic links are refused rather than followed: a link could name a path
 * outside the payload, and the deployment-side check would then hash a file that
 * was never transferred. An empty directory is not representable in the record
 * and does not need to be: Wrangler uploads files.
 */
export function listFiles(directory, prefix = "") {
  const entries = [];

  for (const entry of Deno.readDirSync(directory)) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const absolute = join(directory, entry.name);

    if (entry.isSymlink) {
      fail(
        `the payload contains a symbolic link, which cannot be hashed: ${relative}`,
      );
    }
    if (entry.isDirectory) {
      entries.push(...listFiles(absolute, relative));
      continue;
    }
    if (!entry.isFile) {
      fail(`the payload contains a non-regular file: ${relative}`);
    }
    entries.push(relative);
  }

  return entries.sort();
}

/** The aggregate digest over a set of file records: one `<sha256>  <path>` line each. */
export async function digestOfRecords(records) {
  const text = records
    .map((record) => `${record.sha256}  ${record.path}`)
    .join("\n");

  return `sha256:${await sha256Hex(new TextEncoder().encode(`${text}\n`))}`;
}

/** Hash one payload tree into its manifest records. */
export async function hashPayload(directory) {
  const files = listFiles(directory);
  const records = [];

  for (const relative of files) {
    const bytes = Deno.readFileSync(join(directory, relative));
    records.push({
      path: relative,
      bytes: bytes.length,
      sha256: await sha256Hex(bytes),
    });
  }

  return { records, digest: await digestOfRecords(records) };
}

/**
 * The `[tools]` table of `.mise.toml`, as the build environment it pins.
 *
 * Read rather than re-derived: the tuple is the project's own declaration, and
 * the deployment side only needs to record which one produced the payload.
 */
export function readToolchainPins(root) {
  let text;
  try {
    text = readFileSync(join(root, ".mise.toml"), "utf8");
  } catch (error) {
    fail(`cannot read ${join(root, ".mise.toml")} (${error.message})`);
  }

  const tools = {};
  let inTools = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inTools = line === "[tools]";
      continue;
    }
    if (!inTools || line.length === 0 || line.startsWith("#")) continue;

    const entry = /^("?)([A-Za-z0-9:@/._-]+)\1\s*=\s*"([^"]*)"$/.exec(line);
    if (entry !== null) tools[entry[2]] = entry[3];
  }

  if (Object.keys(tools).length === 0) {
    fail(
      `the toolchain pins in ${join(root, ".mise.toml")} declare no [tools]`,
    );
  }
  return tools;
}

/**
 * The build identity `scripts/build.sh` wrote into the delivered page.
 *
 * The file is regenerated by every build, so its presence is also evidence that
 * a build ran in this tree.
 */
export function readBuildIdentity(root) {
  const file = join(root, "src", "build-identity.ts");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(
      `no build identity at ${file} (${error.message}); run \`deno task build\` ` +
        `first so the hand-off can name the build that produced it`,
    );
  }

  const sha = /sha:\s*"([^"]*)"/.exec(text);
  const deployment = /deployment:\s*"([^"]*)"/.exec(text);
  if (sha === null || deployment === null) {
    fail(`${file} does not declare the sha and deployment fields`);
  }

  return { sha: sha[1], deployment: deployment[1] };
}

/** The generated Wrangler configuration, as the payload publishes it. */
function readGeneratedConfig(payloadDirectory) {
  const file = join(payloadDirectory, GENERATED_CONFIG);
  let config;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read the generated configuration ${file} (${error.message})`);
  }
  return config;
}

/**
 * Fail unless the payload has everything the deployment path reads.
 *
 * `worker/index.js.map` is required exactly when the generated configuration
 * enables `upload_source_maps`: Wrangler validates that companion file while it
 * prepares the upload, so its absence is a deployment failure, not a warning.
 */
export function requireDeployableFiles(payloadDirectory) {
  const present = new Set(listFiles(payloadDirectory));

  for (const required of REQUIRED_FILES) {
    if (!present.has(required)) {
      fail(`the payload is missing ${required}`);
    }
  }

  const config = readGeneratedConfig(payloadDirectory);
  if (config.upload_source_maps === true && !present.has(WORKER_SOURCE_MAP)) {
    fail(
      `the generated configuration enables upload_source_maps but the payload ` +
        `is missing ${WORKER_SOURCE_MAP}`,
    );
  }

  return config;
}

/** Copy the payload tree, preserving relative paths and hidden files. */
export function copyPayload(source, destination) {
  Deno.mkdirSync(destination, { recursive: true });

  for (const relative of listFiles(source)) {
    const target = join(destination, relative);
    Deno.mkdirSync(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    Deno.copyFileSync(join(source, relative), target);
  }

  return listFiles(destination);
}

/** Remove a directory tree when it exists; tolerate an absent one. */
function removeTreeIfPresent(directory) {
  try {
    Deno.removeSync(directory, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Build the hand-off record for a built project. */
async function buildManifest(root) {
  const payloadDirectory = join(root, PAYLOAD_DIR);
  let stat;
  try {
    stat = Deno.statSync(payloadDirectory);
  } catch (error) {
    fail(
      `no build output at ${payloadDirectory} (${error.message}); run ` +
        `\`deno task build\` first`,
    );
  }
  if (!stat.isDirectory) fail(`${payloadDirectory} is not a directory`);

  const config = requireDeployableFiles(payloadDirectory);
  const payload = await hashPayload(payloadDirectory);
  const identity = readBuildIdentity(root);

  return {
    schema: MANIFEST_SCHEMA,
    build: {
      // The identity `scripts/build.sh` compiled into the page, and the generated
      // Worker name the build produced. The Worker name is the *build* identity:
      // a deployment may deploy this payload under another name with
      // `wrangler deploy --name`, and this record then names the build it used.
      sha: identity.sha,
      deployment: identity.deployment,
      workerName: config.name,
      compatibilityDate: config.compatibility_date,
    },
    toolchain: readToolchainPins(root),
    payload: {
      root: PAYLOAD_DIR,
      fileCount: payload.records.length,
      digest: payload.digest,
      files: payload.records,
    },
  };
}

/** Serialise a manifest deterministically: stable order, trailing newline. */
export function renderManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Produce the hand-off: copy `dist/` into `out` and write the manifest there.
 *
 * When `out` is the project root itself, the payload is already in place and only
 * the record is written — that is the combined build-then-deploy path, where the
 * project root becomes the hand-off directory. Otherwise the payload is copied
 * first and the copy is re-hashed, so the record describes exactly the bytes that
 * will be transferred rather than the tree they came from.
 */
export async function packArtefact({ root = Deno.cwd(), out }) {
  const target = out ?? root;
  if (typeof target !== "string" || target.length === 0) {
    fail("pack requires an output directory");
  }

  const manifest = await buildManifest(root);
  const builtPayload = join(root, PAYLOAD_DIR);

  Deno.mkdirSync(target, { recursive: true });
  const realRoot = Deno.realPathSync(root);
  const realTarget = Deno.realPathSync(target);

  if (realTarget === realRoot) {
    Deno.writeTextFileSync(
      join(realRoot, MANIFEST_FILE),
      renderManifest(manifest),
    );
    return {
      manifest,
      out: realRoot,
      payloadDirectory: join(realRoot, PAYLOAD_DIR),
    };
  }

  const payloadTarget = join(realTarget, PAYLOAD_DIR);
  if (payloadTarget === builtPayload) {
    fail(`refusing to pack a payload onto itself: ${payloadTarget}`);
  }

  removeTreeIfPresent(payloadTarget);
  copyPayload(builtPayload, payloadTarget);

  const copied = await hashPayload(payloadTarget);
  if (copied.digest !== manifest.payload.digest) {
    fail(
      `the copied payload does not match the built payload ` +
        `(${copied.digest} != ${manifest.payload.digest})`,
    );
  }

  Deno.writeTextFileSync(
    join(realTarget, MANIFEST_FILE),
    renderManifest(manifest),
  );
  return { manifest, out: realTarget, payloadDirectory: payloadTarget };
}

/** Validate the shape of a received manifest and return it. */
export function parseManifest(text, label = MANIFEST_FILE) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }

  if (
    manifest === null || typeof manifest !== "object" || Array.isArray(manifest)
  ) {
    fail(`${label} must be a JSON object`);
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    fail(
      `${label} has schema ${JSON.stringify(manifest.schema)}, expected ` +
        `${MANIFEST_SCHEMA}`,
    );
  }
  if (
    manifest.build === null ||
    typeof manifest.build !== "object" ||
    typeof manifest.build.sha !== "string" ||
    typeof manifest.build.deployment !== "string" ||
    typeof manifest.build.workerName !== "string"
  ) {
    fail(`${label} records no build identity`);
  }
  if (
    manifest.payload === null ||
    typeof manifest.payload !== "object" ||
    !Array.isArray(manifest.payload.files) ||
    typeof manifest.payload.digest !== "string"
  ) {
    fail(`${label} records no payload`);
  }

  return manifest;
}

/**
 * Verify a received hand-off against its own manifest.
 *
 * Fails closed on a missing manifest, a missing payload, a missing required
 * file, an extra file, an altered file or a digest that does not describe the
 * payload. Every failure names the path, so a truncated transfer and a modified
 * file stay distinguishable.
 */
export async function verifyArtefact({ root = Deno.cwd() }) {
  const manifestPath = join(root, MANIFEST_FILE);
  let text;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (error) {
    fail(
      `no hand-off manifest at ${manifestPath} (${error.message}); the ` +
        `deployment consumes the artefact produced by the build job, which ` +
        `always writes one`,
    );
  }

  const manifest = parseManifest(text, manifestPath);
  const payloadDirectory = join(root, manifest.payload.root ?? PAYLOAD_DIR);

  let stat;
  try {
    stat = Deno.statSync(payloadDirectory);
  } catch (error) {
    fail(`no payload at ${payloadDirectory} (${error.message})`);
  }
  if (!stat.isDirectory) fail(`${payloadDirectory} is not a directory`);

  requireDeployableFiles(payloadDirectory);
  const observed = await hashPayload(payloadDirectory);

  const expected = new Map(
    manifest.payload.files.map((record) => [record.path, record]),
  );
  const actual = new Map(
    observed.records.map((record) => [record.path, record]),
  );

  const missing = [...expected.keys()].filter((path) => !actual.has(path))
    .sort();
  const unexpected = [...actual.keys()].filter((path) => !expected.has(path))
    .sort();
  const altered = [];
  for (const [path, record] of expected) {
    const found = actual.get(path);
    if (found !== undefined && found.sha256 !== record.sha256) {
      altered.push(path);
    }
  }

  const problems = [];
  if (missing.length > 0) {
    problems.push(`missing from the payload: ${missing.join(", ")}`);
  }
  if (unexpected.length > 0) {
    problems.push(`not in the manifest: ${unexpected.join(", ")}`);
  }
  if (altered.length > 0) {
    problems.push(`altered since the build: ${altered.sort().join(", ")}`);
  }
  if (observed.digest !== manifest.payload.digest) {
    problems.push(
      `the payload digest is ${observed.digest}, the manifest records ` +
        `${manifest.payload.digest}`,
    );
  }

  if (problems.length > 0) {
    fail(problems.join("; "));
  }

  return {
    manifest,
    fileCount: observed.records.length,
    digest: observed.digest,
    payloadDirectory,
  };
}

function usage() {
  return [
    "Usage:",
    "  deno run --allow-read --allow-write --allow-env scripts/artefact.mjs pack [--root DIR] [--out DIR]",
    "  deno run --allow-read --allow-env scripts/artefact.mjs verify [--root DIR]",
    "",
    `pack    turn <root>/${PAYLOAD_DIR} into a hand-off: write <out>/${MANIFEST_FILE}`,
    "        and, when <out> is not <root>, copy the payload there first",
    `verify  re-hash <root>/${PAYLOAD_DIR} and compare it with <root>/${MANIFEST_FILE}`,
  ].join("\n");
}

/** Split `[--flag value] [--flag=value]` into options and a subcommand. */
export function parseArgs(argv) {
  const options = { command: undefined, root: Deno.cwd(), out: undefined };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    // `deno task <name> -- <args>` forwards the separator literally, so it is
    // accepted and ignored rather than rejected as an unknown option.
    if (argument === "--") continue;
    if (argument === "--root" || argument === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        fail(`${argument} requires a directory`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--root=") || argument.startsWith("--out=")) {
      const [flag, ...rest] = argument.split("=");
      options[flag.slice(2)] = rest.join("=");
      continue;
    }
    if (argument.startsWith("-")) {
      fail(`unknown option ${JSON.stringify(argument)}`);
    }
    positional.push(argument);
  }

  if (positional.length > 1) {
    fail(
      `expected one command, received ${positional.length}: ${
        positional.join(", ")
      }`,
    );
  }
  options.command = positional[0];
  return options;
}

/** CLI entry point; returns a process exit code. */
export async function main(argv = Deno.args, io = console) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.error(`artefact: ${error.message}\n\n${usage()}`);
    return 2;
  }

  if (options.help) {
    io.log(usage());
    return 0;
  }

  try {
    if (options.command === "pack") {
      const result = await packArtefact({
        root: options.root,
        out: options.out,
      });
      const { manifest } = result;
      io.log(
        `Artefact hand-off written to ${result.out}: ` +
          `${manifest.payload.fileCount} file(s), ${manifest.payload.digest} ` +
          `(worker "${manifest.build.workerName}", build ` +
          `${manifest.build.sha}/${manifest.build.deployment}).`,
      );
      return 0;
    }

    if (options.command === "verify") {
      const result = await verifyArtefact({ root: options.root });
      const { manifest } = result;
      io.log(
        `Hand-off verified: ${result.fileCount} file(s), ${result.digest} ` +
          `(worker "${manifest.build.workerName}", build ` +
          `${manifest.build.sha}/${manifest.build.deployment}).`,
      );
      return 0;
    }
  } catch (error) {
    if (error instanceof ArtefactError) {
      io.error(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }

  io.error(usage());
  return 2;
}

if (import.meta.main) {
  Deno.exitCode = await main();
}
