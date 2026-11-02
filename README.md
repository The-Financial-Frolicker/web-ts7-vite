# __PROJECT_NAME__

Browser app + Cloudflare Worker + WebAssembly, built with Vite and Emscripten.

## Starting a new project from this template

This repository is a starter template. Its identity — package name, page title,
README heading, Worker service identifier and deployed Worker name — is stored
as a single placeholder token. Initialisation is a deliberate, **one-time** step
for a new project: run it once, before the first build or deployment.

### 1. Create the repository

- **GitHub template workflow:** choose _Use this template → Create a new
  repository_, clone the new repository, then run the initialiser below. GitHub
  copies files verbatim: it does not substitute text inside them, and it knows
  nothing about `wrangler.jsonc` or `worker/index.ts`, so the initialiser is
  required in this workflow too.
- **Local workflow:** clone or copy this directory, then run the initialiser.

The repository/directory name is chosen by GitHub or your shell and is not
changed by this tooling. The project name is always supplied explicitly; it is
never inferred from the directory. Update the Git remote with
`git remote set-url origin <url>` if needed.

### 2. Initialise the project identity

From the project root:

```bash
# preview every change; writes nothing
mise exec -- node scripts/init-project.mjs my-app --dry-run

# apply
mise exec -- node scripts/init-project.mjs my-app
```

Equivalent task-runner forms:

```bash
mise exec -- deno task init:project my-app --dry-run
mise exec -- npm run init:project -- my-app --dry-run
```

`node scripts/init-project.mjs --help` documents the placeholder, target files,
name rules and exit codes. After initialising, review the result with `git diff`
and commit; initialisation is not meant to be re-run on the same project.

#### Project-name rules

The name must be valid as **both** an npm `package.json` name and a Cloudflare
Worker identity:

- npm: lowercase, URL-safe, must not start with `.` or `_`, and must not be a
  reserved name (for example `node_modules`).
- Worker: lowercase letters, digits and single hyphens, starting and ending with
  a letter or digit. Underscores, dots, tildes, spaces, slashes, uppercase and
  leading/trailing/repeated hyphens are rejected.
- The derived service identifier is `<name>-worker`. It must also fit
  Cloudflare's 63-character Worker-name limit, so `<name>` may be at most **56**
  characters.

Name validation runs before any file is read and reports which convention
failed.

### What gets replaced

| File              | Field                            | Example result               |
| ----------------- | -------------------------------- | ---------------------------- |
| `package.json`    | `name`                           | `"name": "my-app"`           |
| `index.html`      | `<title>`                        | `<title>my-app</title>`      |
| `README.md`       | top-level heading                | `# my-app`                   |
| `worker/index.ts` | `/api/health` service identifier | `"service": "my-app-worker"` |
| `wrangler.jsonc`  | deployed Worker name             | `"name": "my-app"`           |

### Project states

Initialisation is intentionally strict and runs once:

- **Untouched template:** all five identity fields contain the placeholder and
  no token appears anywhere else. This is the only state that is initialised.
- **Fully initialised project:** no placeholders remain and the five identity
  values agree with `package.json`'s `name`. This is a no-op: the command prints
  `Project is already initialised` and exits `0`.
- **Partially initialised, customised or inconsistent:** some placeholders
  remain, identity values disagree, a required file is missing, or the token
  appears outside the manifest. The command aborts with exit code `2` and
  **modifies nothing**. Customised values are never overwritten or silently
  repaired.

An already initialised project is never renamed by this command. To rename one,
edit the identity files manually or start again from a fresh template.

### Safety guarantees

`scripts/init-project.mjs` is a dependency-free Node script, and initialisation
is a two-phase operation:

1. It reads and validates every target file and the rest of the repository, then
   constructs the complete set of replacements in memory. Nothing is written in
   this phase.
2. Only after every check passes does it stage the new contents in temporary
   files next to each target and atomically rename them into place, preserving
   file modes. If a write fails, it removes remaining temporary files, makes a
   best-effort rollback and reports exactly which files were affected.

Only literal placeholder tokens are replaced, in exactly the five declared
files, with an expected count of one per file. Unrelated text, formatting,
comments, line endings (LF/CRLF), missing trailing newlines and file modes are
preserved. Because validation completes before the first write, an invalid name,
a missing or unexpected placeholder, a straggler token, or a
partial/customised/inconsistent project leaves every file byte-for-byte
unchanged. `--dry-run` performs no writes at all and lists every file and every
`-`/`+` line that would change.

#### Exit codes

| Code | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| `0`  | Initialised, dry run, or already initialised (no-op)                                             |
| `1`  | Usage or project-name validation error                                                           |
| `2`  | Project state error: missing file, placeholder problem, partial/customised/inconsistent identity |
| `3`  | Writing the initialised files failed                                                             |

### Uninitialised template fails fast

The placeholder is intentionally _not_ a valid Cloudflare Worker name, so
Wrangler and the Cloudflare Vite plugin reject it: `npm run dev`,
`deno task build`, `check:worker-types` and `deploy` all refuse to run until the
project is initialised. An uninitialised copy cannot be built or deployed by
accident.

The initialiser stays in the repository so repeat runs are self-explanatory. To
remove it, delete `scripts/init-project.mjs`, `scripts/init-project.test.mjs`
and the `init:project` / `test:init` entries in `package.json` and `deno.json`.

### Template maintenance

The initialiser's tests live in `scripts/init-project.test.mjs`:

```bash
mise exec -- deno task test:init
```

If you add another file that carries project identity, add the placeholder to
it, list it in `TARGETS` at the top of `scripts/init-project.mjs` with its
expected occurrence count, and extend the table above. Update the identity
extractor if the new field is not one of the five existing kinds.

To offer this repository as a GitHub template, enable **Settings → General →
Template repository** once; the _Use this template_ button then copies the files
verbatim, and new projects still run the initialiser as described above.

This entire "Starting a new project" section is documentation only: once your
project is initialised, you can delete it.

## Toolchain

Every tool this project needs is pinned in [`.mise.toml`](.mise.toml) and
installed by [mise](https://mise.jdx.dev/). Nothing has to be installed
globally, and no tool version is inherited from the host distribution.

| Tool                 | Pinned version | Used for                                                   |
| -------------------- | -------------- | ---------------------------------------------------------- |
| Node.js              | `24.19.0`      | Vite, TypeScript (`tsc`), Wrangler, Node-based smoke tests |
| Deno                 | `2.9.8`        | Task runner (`deno.json`) and npm dependency installation  |
| CMake                | `4.4.5`        | Configuring the C++ → WebAssembly build                    |
| Ninja                | `1.13.2`       | CMake generator used for the WebAssembly build             |
| Emscripten (`emsdk`) | `6.0.13`       | C++23 → WebAssembly compiler and CMake toolchain file      |

`package.json` declares `engines.node >= 22.12.0` as the **minimum** supported
version; `.mise.toml` pins the exact known-good version for reproducible builds.

CMake is deliberately pinned to `4.4.5`: Emscripten 6.0.13's CMake toolchain
file warns for the `4.2.0`–`4.3.3` range, and `wasm/CMakeLists.txt` requires at
least `4.2`.

## Setup

### 1. Install mise

```bash
curl https://mise.run | sh        # installs the mise binary
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
source ~/.bashrc
```

Restart your shell (or `source ~/.bashrc`) so mise's activation hook is active.

### 2. Install the pinned toolchain

From the project root:

```bash
mise trust          # trust this project's .mise.toml (first time only)
mise install        # node, deno, cmake, ninja and emsdk@6.0.13
```

The first run downloads the Emscripten SDK (~1.7 GB) and takes a few minutes.
Subsequent clones reuse mise's cached installs.

### 3. Install dependencies

```bash
mise exec -- deno install --frozen
```

`deno install` installs the npm dependencies declared in `package.json` into
`node_modules`, using `deno.lock` for resolution. `--frozen` makes the install
fail if the lockfile is out of date instead of silently changing it.

### 4. Verify

```bash
mise exec -- node --version     # v24.19.0
mise exec -- deno --version     # deno 2.9.8
mise exec -- cmake --version    # cmake version 4.4.5
mise exec -- ninja --version    # 1.13.2
mise exec -- emcc --version     # ... 6.0.13 (...)
```

## Common tasks

```bash
mise exec -- deno task build               # full build (WASM + typecheck + Vite)
mise exec -- deno task test:wasm           # build-tree WASM smoke test
mise exec -- deno task test:wasm:published # published (dist/client) WASM smoke test
mise exec -- deno task check:worker        # typecheck the Cloudflare Worker
mise exec -- deno task fmt                 # format sources in place
mise exec -- deno task fmt:check           # verify formatting (no writes)
mise exec -- deno task lint                # lint sources
mise exec -- deno task validate            # format + lint + typecheck + init tests
mise exec -- deno task ci                  # full CI-equivalent validation
mise exec -- npm run dev                   # Vite dev server
```

`mise exec --` runs a command with the pinned toolchain on `PATH`. If mise is
already active in your shell, the plain `deno task …` / `npm run …` forms work
too. The `#!/usr/bin/env node` shims in `node_modules/.bin` (used by `tsc` and
`vite`) and the `node …` test commands all resolve to the pinned Node.

The build prints the resolved tool versions as step `[1/9]` so a failing build
shows exactly which toolchain produced it.

## Formatting, linting and CI

Formatting and linting use Deno's built-in formatter and linter; the
configuration lives in `deno.json`. Two files are excluded, each for a specific
reason:

- `worker-configuration.d.ts` is generated by `deno task types:worker` and is
  excluded from both the formatter and the linter, because it is declaration
  output that must not be edited by hand. Its freshness is checked by
  `deno task check:worker-types`.
- `README.md` is excluded from the formatter only. Deno's Markdown formatter
  treats the underscore-delimited template identity placeholder as bold emphasis
  and rewrites it, which would break project initialisation, so the README is
  maintained by hand.

All other files supported by Deno's formatter and linter are covered.

`deno task validate` is the quick pre-commit check: formatting, linting, the
client and Worker typechecks, and the project-initialisation tests. It works on
an untouched template.

`deno task ci` runs the same checks and then the complete build pipeline. An
untouched template cannot be built or deployed directly because its identity
placeholder is not a valid Cloudflare Worker name, so this command copies the
working tree (including uncommitted changes) to a temporary directory,
initialises a throwaway identity there with `scripts/init-project.mjs`, and runs
the Worker types freshness check, the full build, both WASM smoke tests and
`wrangler deploy --dry-run`. The checkout is never modified, and no Cloudflare
credentials are needed because nothing is deployed.

GitHub Actions runs the same tasks from
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) on pushes to `main` and
on pull requests targeting `main`. The workflow uses `ubuntu-24.04`, installs
the exact toolchain pinned in `.mise.toml` with mise, and caches mise's install
and download directories (including the Emscripten SDK) plus Deno's npm download
cache. It has read-only `contents` permission, uses no secrets and only performs
a deployment dry run.

## How the toolchain is kept predictable

`scripts/build.sh` sources the Emscripten environment to obtain the compiler
tools, then **re-asserts the pinned Node at the front of `PATH`** so that
Emscripten's own bundled Node can never silently become the build runtime. The
script also refuses to run when the `node` it finds resolves inside the
Emscripten SDK tree.

SDK discovery order (first match wins):

1. `EMSDK_ROOT` — explicit override, e.g. a shared `/opt/emsdk` install.
2. `EMSDK` — exported by mise for the pinned `emsdk` tool.
3. `emcc` on `PATH` — the root is derived from the compiler location.
4. `/opt/emsdk` — legacy default.

`build-wasm.sh` also detects a build tree that was configured against a
different Emscripten SDK and reconfigures it from scratch, so a stale
`build-wasm/` can never keep compiling against an old toolchain.

### Published WASM smoke test

`deno task test:wasm:published` (run as
`mise exec -- deno task test:wasm:published`) verifies the **final deployment
artifact** after Vite has built it. It loads `dist/client/wasm/wasm_math.js`
together with its companion `wasm_math.wasm`, instantiates the module, and calls
`_add(19, 23)`.

A successful run prints:

```
published dist/client 19 + 23 = 42
```

and exits with status `0`. This demonstrates that the built WASM binary and its
JS glue were emitted to `dist/client/wasm`, are non-empty, load correctly in
Node, and that the exported `_add` function returns the expected result (`42`).
Run the full build (`deno task build`) first, since the test fails if the
artifacts are missing or empty.

## Deployment

```bash
mise exec -- deno task deploy            # build, then `wrangler deploy`
mise exec -- deno task deploy:dry-run    # build, then `wrangler deploy --dry-run`
```

Deployment requires Cloudflare credentials (`wrangler login`, or a
`CLOUDFLARE_API_TOKEN` in the environment) and deploys using the generated
configuration at `dist/worker/wrangler.json`.
