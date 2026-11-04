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
 * Create a fake emsdk layout: <root>/upstream/emscripten/{emcc,emcc.py}.
 * `version` nests the SDK one level deeper, as mise does with
 * `<install>/emsdk/<version>`. `pythonRequirement` is written as the same
 * `sys.version_info` assertion the real emcc.py carries.
 */
function makeSdk(parent, version = "", pythonRequirement = "3, 10") {
  const root = version ? path.join(parent, version) : parent;
  const bin = path.join(root, "upstream", "emscripten");
  mkdirSync(bin, { recursive: true });

  const emcc = path.join(bin, "emcc");
  writeFileSync(emcc, "#!/bin/sh\nexit 0\n");
  chmodSync(emcc, 0o755);

  writeFileSync(
    path.join(bin, "emcc.py"),
    `import sys\n\nassert sys.version_info >= (${pythonRequirement}), f'emscripten requires python' \n`,
  );

  return { root, bin };
}

/** A minimal PATH containing the external tools the resolver uses. */
function coreutilsPath() {
  const directory = makeTempDir("init-build-bin-");
  for (const tool of ["dirname", "readlink", "head", "mktemp", "rm", "chmod"]) {
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

const pythonResolver = path.join(projectRoot, "scripts", "resolve-python.sh");

/** A stand-in interpreter that reports `version` for `--version`. */
function makeFakePython(directory, name, version) {
  const file = path.join(directory, name);
  writeFileSync(
    file,
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo "Python ${version}"; exit 0; }\nexit 0\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

/**
 * A stand-in mise. `mode` is "fallback" (answers `which` with `provides`) or
 * "unexpected" (fails, so a test can prove mise was never consulted).
 */
function makeFakeMise(directory, mode, provides) {
  const file = path.join(directory, "mise");
  const body = mode === "fallback"
    ? [
      "#!/bin/sh",
      'case "$1" in',
      "  install) exit 0 ;;",
      `  which) echo "${provides}"; exit 0 ;;`,
      "esac",
      "exit 1",
      "",
    ].join("\n")
    : [
      "#!/bin/sh",
      `echo "unexpected mise call: $*" >&2`,
      "exit 1",
      "",
    ].join("\n");
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

/**
 * Run the resolver hermetically and return its parsed result.
 *
 * The resolver reads the Python requirement from the SDK, so every case gets a
 * fake SDK unless one is supplied.
 */
function resolvePython({ sdk, pathDirs, env = {} }) {
  const emsdk = sdk ?? makeSdk(makeTempDir("init-py-sdk-")).root;
  const result = run(bash, {
    args: ["--noprofile", "--norc", pythonResolver],
    env: {
      HOME: os.tmpdir(),
      PATH: [...pathDirs, coreutilsPath()].join(":"),
      EMSDK_ROOT: emsdk,
      ...env,
    },
    clearEnv: true,
  });
  const lines = result.stdout.trim().split("\n").filter((line) => line !== "");

  return {
    code: result.code,
    path: lines[0] ?? "",
    version: lines[1] ?? "",
    source: lines[2] ?? "",
    requirement: lines[3] ?? "",
    stderr: result.stderr,
  };
}

describe("Python interpreter resolution", () => {
  it("uses a suitable host python3 and never consults mise", () => {
    const tools = makeTempDir("init-py-host-");
    const python = makeFakePython(tools, "python3", "3.11.9");
    makeFakeMise(tools, "unexpected");

    const result = resolvePython({ pathDirs: [tools] });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.path, python);
    assert.equal(result.version, "3.11.9");
    assert.equal(result.source, "host python3");
    assert.equal(result.requirement, "3.10");
    assert.doesNotMatch(result.stderr, /unexpected mise call/);
  });

  it("takes the requirement and the fallback version from the SDK", () => {
    // An SDK whose emcc.py demands 3.11 must reject a 3.10 host and provision
    // 3.11 — not a version this project chose in advance.
    const tools = makeTempDir("init-py-req-");
    const fallback = makeFakePython(tools, "py-fallback", "3.11.7");
    makeFakePython(tools, "python3", "3.10.13");
    const mise = makeFakeMise(tools, "fallback", fallback);
    const sdk = makeSdk(makeTempDir("init-py-req-sdk-"), "", "3, 11");

    const result = resolvePython({ sdk: sdk.root, pathDirs: [tools] });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requirement, "3.11");
    assert.equal(result.source, "mise fallback");
    assert.equal(result.path, fallback);
    assert.match(result.stderr, /Provisioning Python 3\.11 with mise/);
    assert.match(result.stderr, /3\.10\.13/);
    assert.equal(mise, path.join(tools, "mise"));
  });

  it("provisions a fallback when the host python3 is too old", () => {
    const tools = makeTempDir("init-py-old-");
    const fallback = makeFakePython(tools, "py-fallback", "3.10.14");
    makeFakePython(tools, "python3", "3.9.18");
    makeFakeMise(tools, "fallback", fallback);

    const result = resolvePython({ pathDirs: [tools] });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.path, fallback);
    assert.equal(result.version, "3.10.14");
    assert.equal(result.source, "mise fallback");
    assert.match(result.stderr, /3\.9\.18/);
    assert.match(result.stderr, /Provisioning Python 3\.10 with mise/);
  });

  it("refuses to guess when the SDK has no requirement assertion", () => {
    const tools = makeTempDir("init-py-noassert-");
    makeFakePython(tools, "python3", "3.11.9");
    const sdk = makeSdk(makeTempDir("init-py-noassert-sdk-"));
    writeFileSync(path.join(sdk.bin, "emcc.py"), "import sys\n");

    const result = resolvePython({ sdk: sdk.root, pathDirs: [tools] });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /Refusing to guess Emscripten's Python minimum/,
    );
  });

  it("fails when the SDK cannot be located at all", () => {
    const tools = makeTempDir("init-py-nosdk-");
    makeFakePython(tools, "python3", "3.11.9");

    const result = resolvePython({
      sdk: path.join(tools, "absent-sdk"),
      pathDirs: [tools],
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /missing|unknown/);
  });

  it("provisions a fallback when no python3 is available", () => {
    const tools = makeTempDir("init-py-none-");
    const fallback = makeFakePython(tools, "py-fallback", "3.13.2");
    makeFakeMise(tools, "fallback", fallback);

    const result = resolvePython({ pathDirs: [tools] });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.source, "mise fallback");
    assert.match(result.stderr, /no python3 was found on PATH/);
  });

  it("honours a valid explicit EMSDK_PYTHON over the host python3", () => {
    const tools = makeTempDir("init-py-explicit-");
    const explicit = makeFakePython(tools, "custom-python", "3.12.1");
    makeFakePython(tools, "python3", "3.11.9");
    makeFakeMise(tools, "unexpected");

    const result = resolvePython({
      pathDirs: [tools],
      env: { EMSDK_PYTHON: explicit },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.path, explicit);
    assert.equal(result.version, "3.12.1");
    assert.equal(result.source, "EMSDK_PYTHON");
  });

  it("rejects an unsuitable EMSDK_PYTHON instead of silently falling back", () => {
    const tools = makeTempDir("init-py-explicit-old-");
    const explicit = makeFakePython(tools, "custom-python", "3.8.10");
    const fallback = makeFakePython(tools, "py-fallback", "3.13.2");
    // A working fallback proves the resolver refuses rather than provisions.
    makeFakeMise(tools, "fallback", fallback);

    const result = resolvePython({
      pathDirs: [tools],
      env: { EMSDK_PYTHON: explicit },
    });

    assert.equal(result.code, 1);
    assert.equal(result.path, "");
    assert.match(result.stderr, /EMSDK_PYTHON/);
    assert.match(result.stderr, /3\.8\.10/);
  });

  it("rejects an EMSDK_PYTHON that does not exist", () => {
    const tools = makeTempDir("init-py-explicit-missing-");
    makeFakePython(tools, "python3", "3.11.9");

    const result = resolvePython({
      pathDirs: [tools],
      env: { EMSDK_PYTHON: path.join(tools, "absent") },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /does not exist/);
  });

  it("fails clearly when neither python3 nor mise is available", () => {
    const tools = makeTempDir("init-py-no-mise-");

    const result = resolvePython({ pathDirs: [tools] });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /no python3 was found on PATH/);
    assert.match(result.stderr, /mise is not installed/);
  });
});
