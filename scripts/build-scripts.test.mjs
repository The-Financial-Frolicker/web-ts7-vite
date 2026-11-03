import assert from "./lib/assert.mjs";
import { run } from "./lib/command.mjs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const buildScript = path.join(projectRoot, "scripts", "build.sh");
const bash = "/bin/bash";

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(prefix) {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

/**
 * Create a fake emsdk layout: <root>/upstream/emscripten/emcc.
 * `version` nests the SDK one level deeper, as mise does with
 * `<install>/emsdk/<version>`.
 */
function makeSdk(parent, version = "") {
  const root = version ? path.join(parent, version) : parent;
  const bin = path.join(root, "upstream", "emscripten");
  mkdirSync(bin, { recursive: true });

  const emcc = path.join(bin, "emcc");
  writeFileSync(emcc, "#!/bin/sh\nexit 0\n");
  chmodSync(emcc, 0o755);

  return { root, bin };
}

/** A minimal PATH containing the external tools the resolver uses. */
function coreutilsPath() {
  const directory = makeTempDir("init-build-bin-");
  for (const tool of ["dirname", "readlink"]) {
    const result = run("sh", { args: ["-c", `command -v ${tool}`] });
    assert.equal(result.code, 0, result.stderr);
    const resolved = result.stdout.trim();
    symlinkSync(resolved, path.join(directory, tool));
  }
  return directory;
}

function resolveRoot({ emsdkRoot, emsdk, pathDirs = [] }) {
  const env = {
    HOME: os.tmpdir(),
    PATH: [...pathDirs, coreutilsPath()].join(":"),
  };
  if (emsdkRoot !== undefined) env.EMSDK_ROOT = emsdkRoot;
  if (emsdk !== undefined) env.EMSDK = emsdk;

  const result = run(bash, {
    args: ["--noprofile", "--norc", buildScript, "--print-emsdk-root"],
    env,
    clearEnv: true,
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

describe("Emscripten SDK root resolution", () => {
  it("prefers EMSDK_ROOT over EMSDK and emcc on PATH", () => {
    const override = makeSdk(makeTempDir("init-sdk-override-"));
    const fromMise = makeSdk(makeTempDir("init-sdk-mise-"));
    const fromPath = makeSdk(makeTempDir("init-sdk-path-"));

    assert.equal(
      resolveRoot({
        emsdkRoot: override.root,
        emsdk: fromMise.root,
        pathDirs: [fromPath.bin],
      }),
      override.root,
    );
  });

  it("prefers EMSDK over emcc on PATH", () => {
    const fromMise = makeSdk(makeTempDir("init-sdk-mise-"), "6.0.13");
    const fromPath = makeSdk(makeTempDir("init-sdk-path-"));

    assert.equal(
      resolveRoot({ emsdk: fromMise.root, pathDirs: [fromPath.bin] }),
      fromMise.root,
    );
  });

  it("derives a versioned SDK root from emcc on PATH", () => {
    // Regression: this used to walk one directory too far and silently fall
    // back to /opt/emsdk instead of the mise-managed SDK.
    const installs = makeTempDir("init-sdk-installs-");
    const sdk = makeSdk(installs, "6.0.13");

    assert.equal(resolveRoot({ pathDirs: [sdk.bin] }), sdk.root);
  });

  it("derives a top-level SDK root from emcc on PATH", () => {
    const sdk = makeSdk(makeTempDir("init-sdk-top-"));

    assert.equal(resolveRoot({ pathDirs: [sdk.bin] }), sdk.root);
  });

  it("resolves a symlinked emcc before deriving the root", () => {
    const sdk = makeSdk(makeTempDir("init-sdk-linked-"));
    const shims = makeTempDir("init-sdk-shims-");
    symlinkSync(path.join(sdk.bin, "emcc"), path.join(shims, "emcc"));

    assert.equal(resolveRoot({ pathDirs: [shims] }), sdk.root);
  });

  it("falls back to /opt/emsdk when no SDK is configured", () => {
    assert.equal(resolveRoot({}), "/opt/emsdk");
  });

  it("falls back when emcc is not inside an SDK layout", () => {
    const bin = makeTempDir("init-sdk-standalone-");
    const emcc = path.join(bin, "emcc");
    writeFileSync(emcc, "#!/bin/sh\nexit 0\n");
    chmodSync(emcc, 0o755);

    assert.equal(resolveRoot({ pathDirs: [bin] }), "/opt/emsdk");
  });
});
