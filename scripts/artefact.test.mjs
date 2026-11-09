/**
 * Tests for the build → deployment hand-off (`scripts/artefact.mjs`).
 *
 * Load-bearing rules:
 *   * the record names the build that produced the payload;
 *   * the digest covers every payload file, hidden files included;
 *   * a truncated transfer, a modified file and a substituted payload are all
 *     distinguished and refused;
 *   * packing refuses a tree that could not be deployed in the first place.
 *
 * Fixtures are built in a temporary directory: the module reads and writes real
 * files, and a synthetic payload keeps the tests independent of whether this
 * checkout happens to have been built.
 */

import assert from "./lib/assert.mjs";
import { mkdirSync, readFileSync, writeFileSync } from "./lib/fs.mjs";
import path from "./lib/path.mjs";
import { describe, it } from "./lib/test.mjs";
import {
  GENERATED_CONFIG,
  MANIFEST_FILE,
  MANIFEST_SCHEMA,
  packArtefact,
  parseArgs,
  readBuildIdentity,
  readToolchainPins,
  verifyArtefact,
  WORKER_SOURCE_MAP,
} from "./artefact.mjs";

/** A built project tree that mirrors what `deno task build` produces. */
function fixture({ uploadSourceMaps = true } = {}) {
  const root = Deno.makeTempDirSync({ prefix: "artefact-fixture-" });

  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "handoff-probe", private: true }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, ".mise.toml"),
    [
      "[tools]",
      'deno = "2.9.8"',
      '"npm:vite" = "8.3.5"',
      '"npm:wrangler" = "4.156.0"',
      'cmake = "4.4.5"',
      "",
      "[other]",
      'ignored = "1"',
      "",
    ].join("\n"),
  );
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "src", "build-identity.ts"),
    [
      "export const BUILD_IDENTITY = {",
      '  sha: "cafe1234",',
      '  deployment: "handoff-probe",',
      "};",
      "",
    ].join("\n"),
  );

  const payload = path.join(root, "dist");
  mkdirSync(path.join(payload, "worker", ".vite"), { recursive: true });
  mkdirSync(path.join(payload, "client", "assets"), { recursive: true });
  mkdirSync(path.join(payload, "client", "wasm"), { recursive: true });

  writeFileSync(
    path.join(payload, GENERATED_CONFIG),
    `${
      JSON.stringify({
        name: "handoff-probe",
        main: "index.js",
        compatibility_date: "2026-10-30",
        upload_source_maps: uploadSourceMaps,
        no_bundle: true,
        assets: { binding: "ASSETS", directory: "../client" },
      })
    }\n`,
  );
  writeFileSync(
    path.join(payload, "worker", "index.js"),
    "export default {}\n",
  );
  writeFileSync(path.join(payload, "worker", "index.js.map"), "{}\n");
  writeFileSync(path.join(payload, "worker", ".vite", "manifest.json"), "{}\n");
  writeFileSync(
    path.join(payload, "client", "index.html"),
    "<!doctype html>\n",
  );
  writeFileSync(
    path.join(payload, "client", ".assetsignore"),
    "wrangler.json\n",
  );
  writeFileSync(path.join(payload, "client", "assets", "index-abc.js"), "x\n");
  writeFileSync(path.join(payload, "client", "wasm", "wasm_math.js"), "glue\n");
  writeFileSync(
    path.join(payload, "client", "wasm", "wasm_math.wasm"),
    "bin\n",
  );

  return { root, payload };
}

function removeTree(directory) {
  try {
    Deno.removeSync(directory, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Run a body against a fixture tree and always clean it up. */
async function withFixture(options, body) {
  const fixtureTree = fixture(options);
  try {
    await body(fixtureTree);
  } finally {
    removeTree(fixtureTree.root);
  }
}

/** Await a promise that must fail, and assert on the message. */
async function rejectsWith(body, pattern) {
  try {
    await body();
  } catch (error) {
    assert.match(String(error?.message ?? error), pattern);
    return error;
  }
  throw new Error(`expected a rejection matching ${pattern}`);
}

describe("artefact hand-off record", () => {
  it("records the build identity, the pins and the generated Worker name", async () => {
    await withFixture({}, async ({ root }) => {
      const { manifest } = await packArtefact({ root });

      assert.equal(manifest.schema, MANIFEST_SCHEMA);
      assert.equal(manifest.build.sha, "cafe1234");
      assert.equal(manifest.build.deployment, "handoff-probe");
      assert.equal(manifest.build.workerName, "handoff-probe");
      assert.equal(manifest.build.compatibilityDate, "2026-10-30");
      assert.equal(manifest.toolchain.deno, "2.9.8");
      assert.equal(manifest.toolchain["npm:wrangler"], "4.156.0");
      // An entry from another table must not leak into the record.
      assert.equal(manifest.toolchain.ignored, undefined);
    });
  });

  it("writes the record beside the payload when packing in place", async () => {
    await withFixture({}, async ({ root }) => {
      const result = await packArtefact({ root });
      const written = readFileSync(path.join(root, MANIFEST_FILE), "utf8");
      const parsed = JSON.parse(written);

      assert.equal(result.out, Deno.realPathSync(root));
      assert.equal(parsed.payload.digest, result.manifest.payload.digest);
      assert.equal(
        written.endsWith("\n"),
        true,
        "the record must end in a newline",
      );
    });
  });

  it("copies the payload, hidden files included, when packing elsewhere", async () => {
    await withFixture({}, async ({ root, payload }) => {
      const out = Deno.makeTempDirSync({ prefix: "artefact-out-" });
      try {
        const result = await packArtefact({ root, out });
        assert.equal(
          result.payloadDirectory,
          path.join(Deno.realPathSync(out), "dist"),
        );
        assert.equal(
          Deno.readTextFileSync(
            path.join(out, "dist", "client", ".assetsignore"),
          ),
          Deno.readTextFileSync(path.join(payload, "client", ".assetsignore")),
          "hidden files must survive the copy",
        );
        assert.equal(
          Deno.statSync(path.join(out, MANIFEST_FILE)).isFile,
          true,
        );
      } finally {
        removeTree(out);
      }
    });
  });

  it("covers hidden payload files in the digest", async () => {
    await withFixture({}, async ({ root, payload }) => {
      const { manifest } = await packArtefact({ root });
      assert.ok(
        manifest.payload.files.some((file) =>
          file.path === "client/.assetsignore"
        ),
        "the hidden payload file must be recorded",
      );

      // Losing the hidden file is a payload change, so verification must fail.
      Deno.removeSync(path.join(payload, "client", ".assetsignore"));
      await rejectsWith(
        () => verifyArtefact({ root }),
        /missing from the payload: client\/\.assetsignore/,
      );
    });
  });
});

describe("hand-off verification", () => {
  it("accepts the payload the build produced", async () => {
    await withFixture({}, async ({ root }) => {
      const packed = await packArtefact({ root });
      const verified = await verifyArtefact({ root });

      assert.equal(verified.digest, packed.manifest.payload.digest);
      assert.equal(verified.fileCount, packed.manifest.payload.fileCount);
    });
  });

  it("detects an altered payload file", async () => {
    await withFixture({}, async ({ root, payload }) => {
      await packArtefact({ root });
      writeFileSync(path.join(payload, "worker", "index.js"), "tampered\n");

      await rejectsWith(
        () => verifyArtefact({ root }),
        /altered since the build: worker\/index\.js; the payload digest is/,
      );
    });
  });

  it("detects a file added after packaging", async () => {
    await withFixture({}, async ({ root, payload }) => {
      await packArtefact({ root });
      writeFileSync(path.join(payload, "client", "extra.txt"), "injected\n");

      await rejectsWith(
        () => verifyArtefact({ root }),
        /not in the manifest: client\/extra\.txt/,
      );
    });
  });

  it("detects a truncated transfer", async () => {
    await withFixture({}, async ({ root, payload }) => {
      await packArtefact({ root });
      Deno.removeSync(path.join(payload, "client", "wasm", "wasm_math.wasm"));

      await rejectsWith(
        () => verifyArtefact({ root }),
        /missing from the payload: client\/wasm\/wasm_math\.wasm/,
      );
    });
  });

  it("refuses a tree with no hand-off record", async () => {
    await withFixture({}, async ({ root }) => {
      await rejectsWith(
        () => verifyArtefact({ root }),
        /no hand-off manifest at .*artefact-manifest\.json/,
      );
    });
  });

  it("refuses a record that does not describe the payload", async () => {
    await withFixture({}, async ({ root }) => {
      await packArtefact({ root });
      const manifestPath = path.join(root, MANIFEST_FILE);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.payload.digest = "sha256:" + "0".repeat(64);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await rejectsWith(
        () => verifyArtefact({ root }),
        /the payload digest is sha256:\w+, the manifest records sha256:0{64}/,
      );
    });
  });

  it("refuses a record with an unknown schema", async () => {
    await withFixture({}, async ({ root }) => {
      await packArtefact({ root });
      const manifestPath = path.join(root, MANIFEST_FILE);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.schema = 99;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      await rejectsWith(() => verifyArtefact({ root }), /has schema 99/);
    });
  });
});

describe("packing preconditions", () => {
  it("refuses a tree that has not been built", async () => {
    const root = Deno.makeTempDirSync({ prefix: "artefact-unbuilt-" });
    try {
      writeFileSync(path.join(root, "package.json"), '{ "name": "x" }\n');
      await rejectsWith(
        () => packArtefact({ root }),
        /no build output at .*dist/,
      );
    } finally {
      removeTree(root);
    }
  });

  it("refuses a build with no identity to record", async () => {
    await withFixture({}, async ({ root }) => {
      Deno.removeSync(path.join(root, "src", "build-identity.ts"));
      await rejectsWith(
        () => packArtefact({ root }),
        /no build identity at/,
      );
    });
  });

  it("refuses a payload missing a file the deployment reads", async () => {
    await withFixture({}, async ({ root, payload }) => {
      Deno.removeSync(path.join(payload, "worker", "wrangler.json"));
      await rejectsWith(
        () => packArtefact({ root }),
        /the payload is missing worker\/wrangler\.json/,
      );
    });
  });

  it("requires the source map exactly when the config uploads maps", async () => {
    await withFixture({}, async ({ root, payload }) => {
      Deno.removeSync(path.join(payload, WORKER_SOURCE_MAP));
      // The config enables upload_source_maps, so the companion is required.
      await rejectsWith(
        () => packArtefact({ root }),
        /enables upload_source_maps but the payload is missing worker\/index\.js\.map/,
      );
    });

    await withFixture(
      { uploadSourceMaps: false },
      async ({ root, payload }) => {
        Deno.removeSync(path.join(payload, WORKER_SOURCE_MAP));
        // Without the setting the companion is not part of the contract.
        const { manifest } = await packArtefact({ root });
        assert.equal(
          manifest.payload.files.some((file) =>
            file.path === WORKER_SOURCE_MAP
          ),
          false,
        );
      },
    );
  });

  it("refuses a payload that contains a symbolic link", async () => {
    await withFixture({}, async ({ root, payload }) => {
      Deno.symlinkSync("/etc/hostname", path.join(payload, "client", "link"));
      await rejectsWith(
        () => packArtefact({ root }),
        /contains a symbolic link/,
      );
    });
  });
});

describe("artefact record readers", () => {
  it("reads the build identity the build wrote", async () => {
    await withFixture({}, ({ root }) => {
      assert.deepEqual(readBuildIdentity(root), {
        sha: "cafe1234",
        deployment: "handoff-probe",
      });
    });
  });

  it("reads only the [tools] table of the pin file", async () => {
    await withFixture({}, ({ root }) => {
      assert.deepEqual(readToolchainPins(root), {
        deno: "2.9.8",
        "npm:vite": "8.3.5",
        "npm:wrangler": "4.156.0",
        cmake: "4.4.5",
      });
    });
  });
});

describe("command line", () => {
  it("accepts an explicit root and output directory", () => {
    assert.deepEqual(parseArgs(["pack", "--root", "/a", "--out=/b"]), {
      command: "pack",
      root: "/a",
      out: "/b",
    });
  });

  it("accepts the separator `deno task` forwards literally", () => {
    assert.deepEqual(parseArgs(["pack", "--", "--out", "/b"]), {
      command: "pack",
      root: Deno.cwd(),
      out: "/b",
    });
  });

  it("defaults the root to the working directory", () => {
    assert.equal(parseArgs(["verify"]).root, Deno.cwd());
    assert.equal(parseArgs(["verify"]).out, undefined);
  });

  it("rejects an unknown option", () => {
    assert.throws(() => parseArgs(["pack", "--nope"]), /unknown option/);
  });

  it("rejects a flag without a value", () => {
    assert.throws(() => parseArgs(["pack", "--root"]), /requires a directory/);
  });
});
