import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
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

/**
 * Create a temporary project fixture. Pass `null` as a file's contents to omit
 * that file.
 */
function makeProject(overrides = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "init-project-"));
  temporaryRoots.push(root);

  for (
    const [file, contents] of Object.entries({ ...baseFiles(), ...overrides })
  ) {
    if (contents === null) continue;

    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }

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
    {
      skip: typeof process.getuid === "function" && process.getuid() === 0
        ? "requires a non-root user"
        : false,
    },
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

    expectInitError(
      () => parseArgs(["one", "two"]),
      EXIT_USAGE,
      /Expected one project name/,
    );
    expectInitError(() => parseArgs(["--root"]), EXIT_USAGE, /--root requires/);
  });
});
