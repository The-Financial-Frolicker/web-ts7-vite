/**
 * Tests for toolchain package discovery.
 *
 * These cover the reusable discovery primitives only: finding installed
 * packages (including a specific version in a graph with more than one copy)
 * and reading TypeScript's shipped library editions. Contract semantics are
 * tested in `contracts.test.mjs`.
 *
 * Fixtures are synthetic so the tests assert the *logic*, not today's installed
 * versions; the real toolchain is exercised by `deno task check:contracts` and
 * `deno task contract:discover`.
 */
import assert from "./lib/assert.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";

import {
  discoverTypeScript,
  DiscoveryError,
  findPackage,
  newestEdition,
  sortEditions,
} from "./lib/toolchain/discovery.mjs";

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

function write(root, file, contents) {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

const PLATFORM =
  "node_modules/.deno/@typescript+typescript-linux-x64@9.9.9/node_modules/@typescript/typescript-linux-x64";

/** A synthetic install: compiler package plus a platform package with libs. */
function makeInstall(
  {
    version = "9.9.9",
    editions = ["es2022", "es2023", "esnext"],
    libraries = ["dom"],
  } = {},
) {
  const root = makeTempDir("toolchain-");
  write(
    root,
    "node_modules/typescript/package.json",
    JSON.stringify({ name: "typescript", version }),
  );
  write(
    root,
    `${PLATFORM}/package.json`,
    JSON.stringify({ name: "@typescript/typescript-linux-x64", version }),
  );
  for (const edition of editions) {
    write(root, `${PLATFORM}/lib/lib.${edition}.d.ts`, "");
  }
  for (const library of libraries) {
    write(root, `${PLATFORM}/lib/lib.${library}.d.ts`, "");
  }
  return root;
}

describe("edition ordering", () => {
  it("orders numeric editions and puts esnext last", () => {
    assert.deepEqual(
      sortEditions(["esnext", "es2020", "es6", "es2023"]),
      ["es6", "es2020", "es2023", "esnext"],
    );
  });

  it("orders the es6/es2015 alias deterministically, whatever the input order", () => {
    // Both names are ES2015, so they share a rank; the id is the tie-break. Any
    // other ordering would follow the directory listing and differ by machine.
    const forwards = sortEditions(["es6", "es2015", "es2020"]);
    const backwards = sortEditions(["es2020", "es2015", "es6"]);

    assert.deepEqual(forwards, ["es2015", "es6", "es2020"]);
    assert.deepEqual(backwards, forwards);
  });

  it("reports the newest edition and refuses an empty set", () => {
    assert.equal(newestEdition(["es2022", "esnext"]), "esnext");
    assert.equal(newestEdition(["es2022", "es2023"]), "es2023");
    assert.throws(() => newestEdition([]), DiscoveryError);
  });
});

describe("discoverTypeScript", () => {
  it("reads editions and extra libraries from the platform package", () => {
    const typescript = discoverTypeScript(makeInstall());

    assert.equal(typescript.version, "9.9.9");
    assert.deepEqual(typescript.editions, ["es2022", "es2023", "esnext"]);
    assert.deepEqual(typescript.libraries, ["dom"]);
  });

  it("ignores the composite lib files TypeScript also ships", () => {
    const root = makeInstall();
    write(root, `${PLATFORM}/lib/lib.es2023.full.d.ts`, "");
    write(root, `${PLATFORM}/lib/lib.es2023.array.d.ts`, "");

    assert.deepEqual(discoverTypeScript(root).editions, [
      "es2022",
      "es2023",
      "esnext",
    ]);
  });

  it("fails clearly when TypeScript is not installed", () => {
    const root = makeTempDir("toolchain-empty-");
    assert.throws(
      () => discoverTypeScript(root),
      /cannot find typescript|deno install/,
    );
  });
});

describe("findPackage", () => {
  /** Two installed copies of the same package, as a real graph can produce. */
  function makeTwoVersions() {
    const root = makeTempDir("toolchain-versions-");
    for (const version of ["1.0.0", "2.0.0"]) {
      const dir =
        `node_modules/.deno/miniflare@${version}/node_modules/miniflare`;
      write(
        root,
        `${dir}/package.json`,
        JSON.stringify({ name: "miniflare", version }),
      );
    }
    return root;
  }

  it("selects the requested version when the graph pins one", () => {
    const root = makeTwoVersions();

    assert.equal(
      findPackage(root, "miniflare", { version: "2.0.0" }).manifest.version,
      "2.0.0",
    );
    assert.equal(
      findPackage(root, "miniflare", { version: "1.0.0" }).manifest.version,
      "1.0.0",
    );
  });

  it("refuses to guess when two copies are installed and none is requested", () => {
    const root = makeTwoVersions();

    assert.throws(
      () => findPackage(root, "miniflare"),
      /different installed copies/,
    );
  });

  it("reports a missing pinned version instead of returning another one", () => {
    const root = makeTwoVersions();

    assert.throws(
      () => findPackage(root, "miniflare", { version: "3.0.0" }),
      /cannot find miniflare@3\.0\.0/,
    );
  });
});
