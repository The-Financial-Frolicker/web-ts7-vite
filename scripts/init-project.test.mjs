import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  applyChanges,
  deriveWorkerServiceName,
  EXIT_OK,
  EXIT_STATE,
  EXIT_USAGE,
  EXIT_WRITE,
  InitError,
  initialiseProject,
  main,
  MAX_BASE_NAME_LENGTH,
  MAX_PACKAGE_NAME_LENGTH,
  MAX_WORKER_NAME_LENGTH,
  parseArgs,
  PLACEHOLDER,
  TARGETS,
  validateProjectName,
  WORKER_SUFFIX,
} from "./init-project.mjs";

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A minimal stand-in for this repository, whose identity is all placeholder. */
function baseFiles() {
  return {
    "package.json":
      `{\n  "name": "${PLACEHOLDER}",\n  "private": true,\n  "version": "0.0.0"\n}\n`,
    "index.html":
      `<!doctype html>\n<html lang="en">\n  <head>\n    <title>${PLACEHOLDER}</title>\n  </head>\n</html>\n`,
    "README.md":
      `# ${PLACEHOLDER}\n\nBrowser app + Cloudflare Worker + WebAssembly.\n\nHistory note: web-ts7-vite is mentioned here on purpose and must not change.\n`,
    "worker/index.ts":
      `export default {\n  fetch() {\n    return Response.json({ service: "${PLACEHOLDER}${WORKER_SUFFIX}" });\n  },\n};\n`,
    "wrangler.jsonc":
      `{\n  "name": "${PLACEHOLDER}",\n  "main": "./worker/index.ts"\n}\n`,
  };
}

/** The same fixture after a successful initialisation to `name`. */
function initialisedFiles(name) {
  const files = baseFiles();

  for (const [file, contents] of Object.entries(files)) {
    files[file] = contents.split(PLACEHOLDER).join(name);
  }

  return files;
}

/** Write the fixture files into an existing directory. */
function writeProject(root, overrides = {}) {
  for (
    const [file, contents] of Object.entries({ ...baseFiles(), ...overrides })
  ) {
    if (contents === null) continue;

    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
}

/**
 * Create a temporary project fixture. Pass `null` as a file's contents to omit
 * that file.
 */
function makeProject(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "init-project-"));
  temporaryRoots.push(root);
  writeProject(root, overrides);

  return root;
}

function read(root, file) {
  return readFileSync(path.join(root, file), "utf8");
}

/** Snapshot every file (content and mode) so "no changes" can be asserted. */
function fileTree(root, prefix = "") {
  const entries = {};

  for (
    const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })
  ) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      Object.assign(entries, fileTree(root, relative));
    } else if (entry.isFile()) {
      const absolute = path.join(root, relative);
      entries[relative] = {
        mode: statSync(absolute).mode & 0o777,
        content: readFileSync(absolute).toString("base64"),
      };
    }
  }

  return entries;
}

function capture() {
  const stdout = [];
  const stderr = [];

  return {
    stdout,
    stderr,
    io: {
      log: (message) => stdout.push(String(message)),
      error: (message) => stderr.push(String(message)),
    },
  };
}

function init(root, name, extra = {}) {
  const output = capture();
  const result = initialiseProject({
    ...extra,
    root,
    name,
    log: output.io.log,
  });

  return {
    result,
    stdout: output.stdout.join("\n"),
    stderr: output.stderr.join("\n"),
  };
}

function expectInitError(fn, exitCode, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(
      error instanceof InitError,
      `expected InitError, got ${error?.constructor?.name}`,
    );
    assert.equal(error.exitCode, exitCode);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Set when the process runs with privileges that bypass permission bits. */
const permissionSkip = typeof process.getuid === "function" &&
    process.getuid() === 0
  ? "requires a non-root user"
  : false;

/** Set when the platform cannot create symbolic links. */
const symlinkSkip = (() => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "init-project-links-"));
  temporaryRoots.push(directory);

  try {
    symlinkSync("target", path.join(directory, "link"));
    return false;
  } catch {
    return "requires symbolic link support";
  }
})();

/** True when fixtures in the temp directory are scanned through git. */
const tempDirIsGitCheckout = (() => {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: os.tmpdir(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
})();

describe("validateProjectName", () => {
  it("accepts names valid for both npm packages and Cloudflare Workers", () => {
    const longest = "a".repeat(MAX_BASE_NAME_LENGTH);

    for (
      const name of ["a", "my-app", "app2", "a1-b2-c3", "web-ts7-vite", longest]
    ) {
      assert.equal(validateProjectName(name), name);
    }

    assert.equal(
      deriveWorkerServiceName(longest).length,
      MAX_WORKER_NAME_LENGTH,
    );
  });

  it("rejects missing, non-string and npm-invalid names with exit code 1", () => {
    const names = [
      undefined,
      null,
      42,
      "",
      "My-App",
      "my app",
      "@scope/app",
      "my/app",
      "my?app",
      ".my-app",
      "_my-app",
      "node_modules",
      "favicon.ico",
      "a".repeat(MAX_PACKAGE_NAME_LENGTH + 1),
    ];

    for (const name of names) {
      expectInitError(
        () => validateProjectName(name),
        EXIT_USAGE,
        /project name|package\.json name/,
      );
    }
  });

  it("names the npm-specific reason for npm-invalid input", () => {
    expectInitError(
      () => validateProjectName(".my-app"),
      EXIT_USAGE,
      /cannot start with/,
    );
    expectInitError(
      () => validateProjectName("node_modules"),
      EXIT_USAGE,
      /npm reserves/,
    );
    expectInitError(
      () => validateProjectName("a".repeat(MAX_PACKAGE_NAME_LENGTH + 1)),
      EXIT_USAGE,
      new RegExp(`limited to ${MAX_PACKAGE_NAME_LENGTH}`),
    );
  });

  it("rejects npm-valid names that are invalid Cloudflare Worker names", () => {
    for (
      const name of [
        "my_app",
        "my.app",
        "my~app",
        "my--app",
        "-my-app",
        "my-app-",
      ]
    ) {
      expectInitError(
        () => validateProjectName(name),
        EXIT_USAGE,
        /Cloudflare Worker/,
      );
    }
  });

  it("rejects a base name longer than the Worker limit", () => {
    expectInitError(
      () => validateProjectName("a".repeat(MAX_WORKER_NAME_LENGTH + 1)),
      EXIT_USAGE,
      new RegExp(`Worker names are limited to ${MAX_WORKER_NAME_LENGTH}`),
    );
  });

  it("rejects names whose derived -worker service name is too long", () => {
    const name = "a".repeat(MAX_BASE_NAME_LENGTH + 1);

    expectInitError(
      () => validateProjectName(name),
      EXIT_USAGE,
      new RegExp(
        `derived Worker service name.*${MAX_WORKER_NAME_LENGTH}.*at most ${MAX_BASE_NAME_LENGTH}`,
      ),
    );
  });
});

function changedFiles(before, after) {
  return Object.keys(after)
    .filter(
      (file) =>
        !before[file] ||
        before[file].content !== after[file].content ||
        before[file].mode !== after[file].mode,
    )
    .sort();
}

describe("initialiseProject", () => {
  it("initialises an untouched template and reports every target", () => {
    const root = makeProject();
    const before = fileTree(root);
    const { result } = init(root, "new-app");

    assert.equal(result.status, "initialised");
    assert.equal(result.name, "new-app");
    assert.deepEqual(
      result.changes.map((change) => change.file),
      TARGETS.map((target) => target.file),
    );
    assert.ok(result.changes.every((change) => change.replacements === 1));

    assert.match(read(root, "package.json"), /"name": "new-app"/);
    assert.match(read(root, "index.html"), /<title>new-app<\/title>/);
    assert.match(read(root, "README.md"), /^# new-app$/m);
    assert.match(read(root, "worker/index.ts"), /service: "new-app-worker"/);
    assert.match(read(root, "wrangler.jsonc"), /"name": "new-app"/);

    for (const target of TARGETS) {
      assert.equal(read(root, target.file).includes(PLACEHOLDER), false);
    }

    assert.deepEqual(
      changedFiles(before, fileTree(root)),
      TARGETS.map((target) => target.file).sort(),
    );
    assert.equal(
      Object.keys(fileTree(root)).some((file) =>
        file.includes(".init-project-")
      ),
      false,
    );
  });

  it("preserves unrelated text, line endings, trailing newlines and modes", () => {
    const root = makeProject({
      "index.html":
        `<title>${PLACEHOLDER}</title>\r\n<p>no trailing newline</p>`,
    });
    const file = path.join(root, "index.html");
    chmodSync(file, 0o640);

    init(root, "new-app");

    assert.equal(
      read(root, "index.html"),
      "<title>new-app</title>\r\n<p>no trailing newline</p>",
    );
    assert.equal(statSync(file).mode & 0o777, 0o640);
    assert.match(
      read(root, "README.md"),
      /History note: web-ts7-vite is mentioned here on purpose and must not change\./,
    );
  });

  it("is genuinely read-only in dry-run mode", () => {
    const root = makeProject();
    const before = fileTree(root);
    const { result, stdout } = init(root, "new-app", { dryRun: true });

    assert.equal(result.status, "dry-run");
    assert.equal(result.changes.length, TARGETS.length);
    assert.deepEqual(fileTree(root), before);

    for (const target of TARGETS) {
      assert.match(stdout, new RegExp(escapeRegExp(target.file)));
    }
    assert.match(stdout, new RegExp(`- .*${escapeRegExp(PLACEHOLDER)}`));
    assert.match(stdout, /No files were changed/);
  });

  it("validates project state during a dry run", () => {
    const files = initialisedFiles("good-app");
    files["wrangler.jsonc"] = files["wrangler.jsonc"].replace(
      '"good-app"',
      '"other-app"',
    );
    const root = makeProject(files);
    const before = fileTree(root);

    expectInitError(
      () => init(root, "good-app", { dryRun: true }),
      EXIT_STATE,
      /identity values are inconsistent/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("is a no-op for a fully initialised project", () => {
    const root = makeProject(initialisedFiles("ready-app"));
    const before = fileTree(root);
    const { result, stdout } = init(root, "ready-app");

    assert.equal(result.status, "already-initialised");
    assert.equal(result.name, "ready-app");
    assert.deepEqual(result.changes, []);
    assert.deepEqual(fileTree(root), before);
    assert.match(stdout, /already initialised as "ready-app"; nothing to do\./);
  });

  it("reports the existing name when an initialised project is given another name", () => {
    const root = makeProject(initialisedFiles("ready-app"));
    const before = fileTree(root);
    const { result, stdout } = init(root, "other-app");

    assert.equal(result.status, "already-initialised");
    assert.equal(result.name, "ready-app");
    assert.deepEqual(fileTree(root), before);
    assert.match(stdout, /already initialised as "ready-app"/);
  });

  it("is safe to run repeatedly", () => {
    const root = makeProject();
    init(root, "new-app");
    const before = fileTree(root);

    const { result } = init(root, "new-app");

    assert.equal(result.status, "already-initialised");
    assert.deepEqual(fileTree(root), before);
  });

  it("aborts when a required identity file is missing", () => {
    const root = makeProject({ "README.md": null });
    const before = fileTree(root);

    expectInitError(
      () => init(root, "new-app"),
      EXIT_STATE,
      /required identity file\(s\) are missing:[\s\S]*README\.md/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("aborts when a required identity file is a directory", () => {
    const root = makeProject({ "package.json": null });
    mkdirSync(path.join(root, "package.json"));
    const before = fileTree(root);

    expectInitError(
      () => init(root, "new-app"),
      EXIT_STATE,
      /package\.json is not a regular file/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("aborts when the placeholder appears outside the five declared files", () => {
    const root = makeProject({
      "docs/notes.md": `Copied from the template: ${PLACEHOLDER}\n`,
    });
    const before = fileTree(root);

    expectInitError(
      () => init(root, "new-app"),
      EXIT_STATE,
      /outside the 5 declared identity files[\s\S]*docs\/notes\.md \(1 occurrence/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("ignores placeholders in generated and installed directories", () => {
    const root = makeProject({
      "node_modules/some-pkg/index.js": `// imported from ${PLACEHOLDER}\n`,
      "dist/assets/app.js": `// built from ${PLACEHOLDER}\n`,
    });
    const before = fileTree(root);
    const { result } = init(root, "new-app");

    assert.equal(result.status, "initialised");
    assert.match(
      read(root, "node_modules/some-pkg/index.js"),
      new RegExp(escapeRegExp(PLACEHOLDER)),
    );
    assert.deepEqual(
      changedFiles(before, fileTree(root)),
      TARGETS.map((target) => target.file).sort(),
    );
  });

  it("ignores binary files that contain the placeholder bytes", () => {
    const root = makeProject({
      "public/logo.bin": Buffer.concat([
        Buffer.from([0x00, 0x01, 0x02]),
        Buffer.from(PLACEHOLDER),
      ]),
    });

    const { result } = init(root, "new-app");

    assert.equal(result.status, "initialised");
  });

  it("ignores the initialiser's own tooling file", () => {
    const tooling = `export const PLACEHOLDER = "${PLACEHOLDER}";\n`;
    const root = makeProject({ "scripts/init-project.mjs": tooling });

    const { result } = init(root, "new-app");

    assert.equal(result.status, "initialised");
    assert.equal(read(root, "scripts/init-project.mjs"), tooling);
  });

  it("aborts on an unexpected placeholder count in a target file", () => {
    const root = makeProject({
      "package.json":
        `{\n  "name": "${PLACEHOLDER}",\n  "description": "${PLACEHOLDER}"\n}\n`,
    });
    const before = fileTree(root);

    expectInitError(
      () => init(root, "new-app"),
      EXIT_STATE,
      /unexpected placeholder counts[\s\S]*package\.json: 2 placeholder/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("aborts on a partially initialised project without overwriting it", () => {
    const root = makeProject({
      "package.json": `{\n  "name": "custom-app",\n  "private": true\n}\n`,
    });
    const before = fileTree(root);

    expectInitError(
      () => init(root, "custom-app"),
      EXIT_STATE,
      /Cannot initialise: the project has unexpected placeholder counts/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("aborts when some files are untouched and others are initialised", () => {
    const files = baseFiles();
    files["package.json"] = files["package.json"].replace(
      PLACEHOLDER,
      "new-app",
    );
    const root = makeProject(files);
    const before = fileTree(root);

    expectInitError(
      () => init(root, "new-app"),
      EXIT_STATE,
      /has unexpected placeholder counts[\s\S]*package\.json: 0 placeholder/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("aborts when a placeholder is present but not in its identity field", () => {
    const root = makeProject({
      "package.json":
        `{\n  "name": "custom-app",\n  "description": "${PLACEHOLDER}"\n}\n`,
    });
    const before = fileTree(root);

    expectInitError(
      () => init(root, "custom-app"),
      EXIT_STATE,
      /partially initialised or customised/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("aborts on inconsistent identity values instead of repairing them", () => {
    const files = initialisedFiles("good-app");
    files["wrangler.jsonc"] = files["wrangler.jsonc"].replace(
      '"good-app"',
      '"other-app"',
    );
    const root = makeProject(files);
    const before = fileTree(root);

    expectInitError(
      () => init(root, "good-app"),
      EXIT_STATE,
      /identity values are inconsistent/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("aborts when an initialised project's name is not a valid project name", () => {
    for (
      const name of [
        "Bad Name",
        "my_app",
        "a".repeat(MAX_BASE_NAME_LENGTH + 1),
      ]
    ) {
      const root = makeProject(initialisedFiles(name));
      const before = fileTree(root);

      expectInitError(
        () => init(root, "good-app"),
        EXIT_STATE,
        /declares a name this template cannot represent[\s\S]*Invalid project name/,
      );
      assert.deepEqual(fileTree(root), before);
    }
  });

  it("aborts when no placeholders remain but package.json has no usable name", () => {
    const files = initialisedFiles("good-app");
    files["package.json"] = `{\n  "private": true\n}\n`;
    const root = makeProject(files);
    const before = fileTree(root);

    expectInitError(
      () => init(root, "good-app"),
      EXIT_STATE,
      /does not declare a usable "name"/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it("rejects an invalid project name before touching any file", () => {
    const root = makeProject();
    const before = fileTree(root);

    expectInitError(
      () => init(root, "Bad Name"),
      EXIT_USAGE,
      /Invalid project name/,
    );
    assert.deepEqual(fileTree(root), before);
  });

  it(
    "reports a write failure without leaving temporary files",
    { skip: permissionSkip },
    () => {
      const root = makeProject();
      const before = fileTree(root);
      chmodSync(root, 0o500);

      try {
        expectInitError(
          () => init(root, "new-app"),
          EXIT_WRITE,
          /Writing the initialised files failed[\s\S]*No project files were modified/,
        );
      } finally {
        chmodSync(root, 0o700);
      }

      assert.deepEqual(fileTree(root), before);
    },
  );

  it(
    "reports an unreadable identity file without changing anything",
    { skip: permissionSkip },
    () => {
      const root = makeProject();
      const before = fileTree(root);
      const file = path.join(root, "README.md");
      const mode = statSync(file).mode & 0o777;
      chmodSync(file, 0o000);

      try {
        expectInitError(
          () => init(root, "new-app"),
          EXIT_STATE,
          /Cannot read README\.md/,
        );
      } finally {
        chmodSync(file, mode);
      }

      assert.deepEqual(fileTree(root), before);
    },
  );

  it(
    "reports an unreadable directory found by the straggler scan",
    {
      skip: permissionSkip ||
        (tempDirIsGitCheckout ? "requires walk-mode scanning" : false),
    },
    () => {
      const root = makeProject({
        "docs/notes.md": "Notes without identity.\n",
      });
      const before = fileTree(root);
      const docs = path.join(root, "docs");
      const mode = statSync(docs).mode & 0o777;
      chmodSync(docs, 0o000);

      try {
        expectInitError(
          () => init(root, "new-app"),
          EXIT_STATE,
          /Cannot scan the project for stray/,
        );
      } finally {
        chmodSync(docs, mode);
      }

      assert.deepEqual(fileTree(root), before);
    },
  );

  it(
    "refuses identity files that resolve outside the project root",
    { skip: symlinkSkip },
    () => {
      const outside = mkdtempSync(
        path.join(os.tmpdir(), "init-project-outside-"),
      );
      temporaryRoots.push(outside);
      writeFileSync(
        path.join(outside, "index.ts"),
        baseFiles()["worker/index.ts"],
      );

      const root = makeProject({ "worker/index.ts": null });
      symlinkSync(outside, path.join(root, "worker"));

      expectInitError(
        () => init(root, "new-app"),
        EXIT_STATE,
        /worker\/index\.ts resolves to .*outside the project root/,
      );
      assert.deepEqual(readdirSync(outside), ["index.ts"]);
    },
  );

  it(
    "aborts when an identity file is a symbolic link",
    { skip: symlinkSkip },
    () => {
      const root = makeProject();
      // Keep the real contents in a directory the straggler scan ignores.
      mkdirSync(path.join(root, "dist"));
      writeFileSync(
        path.join(root, "dist", "wrangler.real.jsonc"),
        baseFiles()["wrangler.jsonc"],
      );
      rmSync(path.join(root, "wrangler.jsonc"));
      symlinkSync(
        "dist/wrangler.real.jsonc",
        path.join(root, "wrangler.jsonc"),
      );

      const before = fileTree(root);

      expectInitError(
        () => init(root, "new-app"),
        EXIT_STATE,
        /wrangler\.jsonc is a symbolic link/,
      );
      assert.deepEqual(fileTree(root), before);
    },
  );

  it("rejects a directory that is not a template", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "init-project-empty-"));
    temporaryRoots.push(root);

    expectInitError(
      () => init(root, "new-app"),
      EXIT_STATE,
      /required identity file/,
    );
  });
});

describe("applyChanges", () => {
  it(
    "refuses a symbolic link introduced after validation",
    { skip: symlinkSkip },
    () => {
      const root = makeProject();
      const target = path.join(root, "wrangler.jsonc");
      const before = read(root, "wrangler.jsonc");
      rmSync(target);
      symlinkSync("package.json", target);

      expectInitError(
        () =>
          applyChanges(root, [
            {
              file: "wrangler.jsonc",
              before,
              after: '{\n  "name": "new-app"\n}\n',
            },
          ]),
        EXIT_WRITE,
        /wrangler\.jsonc is a symbolic link; refusing to replace it[\s\S]*No project files were modified/,
      );

      assert.equal(lstatSync(target).isSymbolicLink(), true);
      assert.deepEqual(
        readdirSync(root).filter((name) => name.includes(".init-project-")),
        [],
      );
    },
  );

  it("rolls back renames that succeeded before a later rename failed", () => {
    const root = makeProject();
    const packageBefore = read(root, "package.json");
    const wranglerBefore = read(root, "wrangler.jsonc");
    const packageMode = statSync(path.join(root, "package.json")).mode & 0o777;
    const replacement = '{\n  "name": "new-app"\n}\n';
    const changes = [
      {
        file: "package.json",
        before: packageBefore,
        after: replacement,
      },
      {
        file: "wrangler.jsonc",
        before: wranglerBefore,
        after: replacement,
      },
    ];

    // Simulate an external change between validation and commit: the second
    // target has become a directory, which a rename cannot replace.
    rmSync(path.join(root, "wrangler.jsonc"));
    mkdirSync(path.join(root, "wrangler.jsonc"));

    expectInitError(
      () => applyChanges(root, changes),
      EXIT_WRITE,
      /while replacing wrangler\.jsonc[\s\S]*rolled back: package\.json/,
    );

    assert.equal(read(root, "package.json"), packageBefore);
    assert.equal(
      statSync(path.join(root, "package.json")).mode & 0o777,
      packageMode,
    );
    assert.deepEqual(
      readdirSync(root).filter((name) => name.includes(".init-project-")),
      [],
    );
  });
});

describe("CLI", () => {
  it("prints help and exits 0", () => {
    const output = capture();

    assert.equal(main(["--help"], output.io), EXIT_OK);

    const stdout = output.stdout.join("\n");
    assert.match(stdout, /Usage:/);
    assert.match(stdout, /Exit codes:/);
    assert.match(stdout, new RegExp(escapeRegExp(PLACEHOLDER)));
  });

  it("initialises a template through main()", () => {
    const root = makeProject();
    const output = capture();

    assert.equal(main(["new-app", "--root", root], output.io), EXIT_OK);

    assert.match(read(root, "package.json"), /"name": "new-app"/);
    assert.match(
      output.stdout.join("\n"),
      /Initialised the project as "new-app"/,
    );
    assert.equal(output.stderr.join("\n"), "");
  });

  it("previews through main() without changing files", () => {
    const root = makeProject();
    const before = fileTree(root);
    const output = capture();

    assert.equal(
      main(["new-app", "--dry-run", "--root", root], output.io),
      EXIT_OK,
    );

    assert.deepEqual(fileTree(root), before);
    assert.match(
      output.stdout.join("\n"),
      /Dry run: would initialise the project as "new-app"/,
    );
  });

  it("returns 1 for invalid names", () => {
    const root = makeProject();
    const before = fileTree(root);
    const output = capture();

    assert.equal(main(["Bad Name", "--root", root], output.io), EXIT_USAGE);

    assert.match(output.stderr.join("\n"), /Invalid project name/);
    assert.deepEqual(fileTree(root), before);
  });

  it("returns 2 for project state errors", () => {
    const root = makeProject({
      "package.json": `{\n  "name": "custom-app",\n  "private": true\n}\n`,
    });
    const before = fileTree(root);
    const output = capture();

    assert.equal(main(["custom-app", "--root", root], output.io), EXIT_STATE);

    assert.match(output.stderr.join("\n"), /Cannot initialise/);
    assert.deepEqual(fileTree(root), before);
  });

  it("requires a project name and rejects unknown options", () => {
    const missingName = capture();
    assert.equal(main([], missingName.io), EXIT_USAGE);
    assert.match(missingName.stderr.join("\n"), /A project name is required/);

    const unknown = capture();
    assert.equal(main(["--bogus", "my-app"], unknown.io), EXIT_USAGE);
    assert.match(unknown.stderr.join("\n"), /Unknown option/);
  });

  it("parses --root=DIR, the -- separator and rejects extra names", () => {
    assert.deepEqual(parseArgs(["--root=/tmp/x", "--", "my-app"]), {
      dryRun: false,
      help: false,
      name: "my-app",
      root: "/tmp/x",
    });

    assert.deepEqual(parseArgs(["--root", "/x", "--root", "/x", "my-app"]), {
      dryRun: false,
      help: false,
      name: "my-app",
      root: "/x",
    });

    expectInitError(
      () => parseArgs(["--root", "/x", "--root", "/y", "my-app"]),
      EXIT_USAGE,
      /--root was given more than once with different values/,
    );
    // Values are compared literally, so equivalent spellings fail closed.
    expectInitError(
      () => parseArgs(["--root", "/x", "--root", "/x/", "my-app"]),
      EXIT_USAGE,
      /--root was given more than once with different values/,
    );
    expectInitError(
      () => parseArgs(["--root", "--dry-run", "my-app"]),
      EXIT_USAGE,
      /--root requires a directory argument/,
    );
    expectInitError(
      () => parseArgs(["--root=", "my-app"]),
      EXIT_USAGE,
      /--root requires a directory argument/,
    );
    expectInitError(
      () => parseArgs(["one", "two"]),
      EXIT_USAGE,
      /Expected one project name/,
    );
    expectInitError(() => parseArgs(["--root"]), EXIT_USAGE, /--root requires/);
  });

  it("accepts a relative --root path containing spaces", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "init-project-space-"));
    temporaryRoots.push(parent);
    const root = path.join(parent, "project with spaces");
    mkdirSync(root);
    writeProject(root);

    const output = capture();
    const relative = path.relative(process.cwd(), root);

    assert.equal(main(["new-app", "--root", relative], output.io), EXIT_OK);

    assert.match(read(root, "package.json"), /"name": "new-app"/);
    assert.equal(output.stderr.join("\n"), "");
  });

  it("returns 1 when --root is not a usable directory", () => {
    const missing = mkdtempSync(path.join(os.tmpdir(), "init-project-gone-"));
    rmSync(missing, { recursive: true, force: true });
    const missingOutput = capture();

    assert.equal(
      main(["new-app", "--root", missing], missingOutput.io),
      EXIT_USAGE,
    );
    assert.match(missingOutput.stderr.join("\n"), /Project root not found/);

    const parent = mkdtempSync(path.join(os.tmpdir(), "init-project-file-"));
    temporaryRoots.push(parent);
    const file = path.join(parent, "not-a-directory");
    writeFileSync(file, "not a project\n");
    const fileOutput = capture();

    assert.equal(main(["new-app", "--root", file], fileOutput.io), EXIT_USAGE);
    assert.match(
      fileOutput.stderr.join("\n"),
      /Project root is not a directory/,
    );
  });
});
