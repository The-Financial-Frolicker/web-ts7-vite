# __PROJECT_NAME__

Browser app + Cloudflare Worker + WebAssembly, built with Vite and Emscripten.

This repository is a starter template. Its identity — package name, page title,
README heading, Worker service identifier and deployed Worker name — is stored
as a single placeholder token. Initialisation is a one-time step for a new
project; run it before the first development server, build or deployment.

The rest of this document is the operational guide: supported environment,
toolchain, initialisation, build, test, deployment and CI.

Commands assume the repository root as the working directory and the pinned
toolchain. `mise exec --` selects it explicitly:

```bash
mise exec -- deno task build
```

If mise is activated in your shell, the plain `deno task build` and
`npm run build` forms work too.

## Quick start

Once mise is installed (see
[Install the toolchain and dependencies](#install-the-toolchain-and-dependencies)),
the shortest path is:

```bash
mise trust
mise install
mise exec -- deno install --frozen
mise exec -- node scripts/init-project.mjs my-app --dry-run
mise exec -- node scripts/init-project.mjs my-app
mise exec -- deno task validate
mise exec -- deno task build
mise exec -- deno task deploy:dry-run
```

`--dry-run` writes nothing; `deploy:dry-run` needs no Cloudflare credentials
and does not deploy. See [Deploy](#deploy) for a real deployment.

## Supported environment

The repository targets a Linux userland:

- Ubuntu; GitHub Actions uses `ubuntu-24.04`.
- Ubuntu on WSL2.
- Linux development containers and cloud VMs with the prerequisites below.

Native Windows and macOS shells are not supported. The scripts use Bash, GNU
`readlink -f`, standard Linux utilities (`dirname`, `awk`, `cp`, `rm`, `mkdir`,
`mktemp`, `ln`) and, for `scripts/ci.sh`, GNU `tar`. On Windows, use WSL2.

On WSL2, keep the checkout in the Linux filesystem (for example
`~/src/my-project`), not under `/mnt/c`. The Windows filesystem does not
preserve Linux executable bits and symbolic links reliably and is slower for
the many small files produced by `node_modules`, CMake and Vite. Windows files
remain accessible from WSL; building from `/mnt/c` is not recommended.

### Host requirements and repository-managed state

The host provides:

- `mise` itself, installed separately;
- a POSIX shell, `git`, `curl` and the Linux utilities listed above;
- network access for the first toolchain and dependency installation;
- a Cloudflare account for a real deployment (not for builds or dry runs).

The repository provides the pinned tools through [`.mise.toml`](.mise.toml)
(including the Python interpreter used by Emscripten), the dependency graph
through [deno.lock](deno.lock), and the build, test and deployment scripts. No
credentials, secrets or Cloudflare account state are stored in the repository.

No Dockerfile or dev-container configuration is included. Any Linux
environment that provides the host requirements can use the repository.

## Runtime ownership

Dependencies fall into four categories, and a runtime requirement in one must
not become a requirement in another.

| Category | Members | Runtime required | Supplied by |
| --- | --- | --- | --- |
| Encapsulated toolchain | Emscripten 6.0.13 and everything it drives | its own Node, Python, LLVM, Binaryen | the toolchain itself |
| External ecosystem | Vite 8.3.5 (Rolldown, lightningcss), Wrangler 4.156.0 (workerd, esbuild, miniflare) | Node | this project (`.mise.toml`) |
| Project-owned infrastructure | Bash build scripts, Deno tasks and the Deno WASM harness, artefact validation, initialisation, CI | Deno | this project |
| Delivered application | browser bundle, Worker bundle, WASM glue | browser / Worker capabilities only | this project |

### Encapsulated toolchain dependencies

Emscripten 6.0.13 is a self-contained SDK. It ships and pins **its own** Node
24.19.0 — `NODE_JS` is an absolute path in its private `.emscripten`
configuration — and uses it internally for `tools/compiler.mjs`,
`tools/preprocessor.mjs` and the JavaScript optimiser. It never uses the Node
this project installs, and this project never invokes Emscripten's copy. That
Node is therefore **not** a requirement for project-installed Node. Python,
LLVM, Binaryen, CMake and Ninja belong to the toolchain in the same way.

### External ecosystem tools

Vite and Wrangler are Node-hosted: both declare `engines.node`, and Vite's
Rolldown and lightningcss components are native bindings loaded by a Node
process. The project installs Node in [`.mise.toml`](.mise.toml) **as their
host**. That is a deliberate external-tooling dependency, not a claim that the
application needs Node.

TypeScript is different in kind. Its semantic checker is a **native Go
executable**; the `tsc` npm entry point is a launcher that resolves that
executable and hands over to it. The launcher is not the semantic engine, so
the checker runs through Deno (`deno task check:client`,
`deno task check:worker`) against the same `tsconfig.json` files, producing the
same diagnostics and exit codes without involving the project Node.

### Project-owned infrastructure

Deno is the preferred runtime: an explicit permission model, built-in formatter,
linter, test runner and task runner, and one API surface to standardise on. The
Deno WASM harness ([wasm/harness.ts](wasm/harness.ts)) is the first piece of
infrastructure to run entirely on Deno. The remaining Node-based scripts and
test suites are known, tracked work — not an endorsed target.

### Delivered application capabilities

The browser application and the Cloudflare Worker may use only the capabilities
of their own runtimes. Node and Deno are both unavailable to them; that boundary
is enforced by the checks described in
[Node.js dependency boundary](#nodejs-dependency-boundary).

### This project is not Node-free

Node remains installed because two external tools require a Node host, and part
of the project-owned infrastructure still runs on it. The documented goal is
narrower and precise: no delivered code, and no new project-owned
infrastructure, depends on Node — while the Node-hosted ecosystem tools keep a
supported host.

## Node.js dependency boundary

Node.js is part of the toolchain, not part of the product. Two things that are
easy to confuse are treated differently:

- **The delivered application** — `src/`, `worker/` and everything the build
  emits into `dist/` — runs in a browser and on Cloudflare Workers. It must not
  import a Node built-in module, read a Node global, or rely on CommonJS.
- **The development toolchain** — the Bash scripts in `scripts/`, the Node
  scripts they run, `vite.config.ts`, and the ecosystem tools pinned in
  [`.mise.toml`](.mise.toml) — is not governed by this boundary. Vite and
  Wrangler need a Node host; Emscripten brings its own. See
  [Runtime ownership](#runtime-ownership).

The policy is therefore narrower than "this repository is Node-free": **Node may
be installed because external tools require it, but project-owned application
code and the delivered application must not acquire a functional dependency on
Node.js or its standard library.**

### What is enforced

The boundary is enforced in four layers, each proving something different:

| Layer | Mechanism | Scope | Where it runs |
| --- | --- | --- | --- |
| 1. Configuration invariants | `deno task check:node-boundary` | `package.json`, `deno.lock`, both `tsconfig.json` files, `wrangler.jsonc` | `validate`, `scripts/ci.sh static`, CI |
| 2. Compiler diagnostics | `deno task check:client`, `check:worker` | `src/`, every `worker/*.ts` module | `validate`, `scripts/ci.sh static`, CI |
| 3. Narrow source policy | `deno task check:node-boundary` | `src/`, `worker/` (`*.d.ts` included, test files excluded) | `validate`, `scripts/ci.sh static`, CI |
| 4. Delivered artefacts | `deno task check:deploy` | `dist/worker`, `dist/client`, published WASM glue, generated Wrangler configuration | `scripts/ci.sh build`, `deno task deploy`, CI |

`deno task test:boundary` tests layers 1 and 3 (including negative canaries and a
Worker-typecheck coverage canary); `deno task test:deploy` tests layer 4.

**Layer 1 — configuration invariants.** The type checker enforces the boundary
only because Node's ambient types are absent. Those assumptions are asserted
explicitly, because a check that depends on configuration must verify its own
premise:

- no `package.json` dependency section depends on `@types/node`;
- `deno.lock` does not pin `@types/node`;
- the client `tsconfig.json` declares `types: ["vite/client"]`;
- `worker/tsconfig.json` declares `types: []`;
- no `lib` entry names a Node library;
- `wrangler.jsonc` enables no `nodejs_compat*` flag (the generated configuration is
  checked again by layer 4).

**Layer 2 — compiler diagnostics.** The compiler resolves imports, aliases and
ambient declarations, and reports `node:fs` as `TS2591` and `process` as
`TS2591`/`TS7017` in both projects. `worker/tsconfig.json` includes
`./**/*.ts`, so a new Worker module is typechecked instead of being silently
ignored.

**Layer 3 — narrow source policy.** Two holes the compiler cannot see: a local
ambient module declaration can legitimise a `node:`/`cloudflare:` module, and a
suppression directive can silence the diagnostic layer 2 depends on. Only these
are rejected:

- `declare module "node:*"` and `declare module "cloudflare:*"` in our own
  sources, including `.d.ts` files;
- `@ts-ignore` and `@ts-expect-error`.

Comments, string/template literals and regex literals are excluded, and
directives are matched only inside comments, so text that merely mentions one
cannot fail the check. There is no allowlist: a legitimate need requires changing
the checker, so it is reviewed.

**Layer 4 — delivered artefacts.** Emitted bundles are checked for `node:`
specifiers, `cloudflare:node` references, `require(...)`, bare `process` access,
`process` reached through `globalThis`/`window`/`self`, `Buffer`,
`module.exports`, `__dirname`/`__filename` and `setImmediate`. A property that
merely shares a name (`logger.process`) is not a dependency. The published glue
is browser-only, as described below.

### Browser-only WASM glue

`wasm/CMakeLists.txt` builds the WebAssembly glue with `-sENVIRONMENT=web`, so
Emscripten emits no Node loading path at all. `check:deploy` holds the glue to
the same rules as every other executable artefact:

- no `node:` module specifier, static or dynamic;
- no `require(...)` loading path;
- no Node capability such as `Buffer`, `module.exports`, `__dirname` or
  `setImmediate`;
- the `ENVIRONMENT_IS_WEB` marker must be present.

Two shapes of Emscripten output are tolerated by design, and both are inert:

- the read-only version probes (`process.versions?.bun`,
  `process.versions?.node`, `globalThis.process?.versions`/`?.type`) that
  Emscripten always emits. They read a version string, load nothing and
  grant no capability, so they are stripped before the `process` rule is applied.
  Any other `process` use — `process.env`, `process.exit`, `process.binding` —
  fails.
- dead `ENVIRONMENT_IS_NODE` text in the environment assertion. Its *absence* is
  not asserted, because the web-only build legitimately retains that identifier.

Building with `web` also means the glue cannot be loaded by Node at all: it
aborts with "not compiled for this environment". That is intended — the
delivered artefact targets browsers — and it is why the smoke tests run on Deno
with a browser-like profile rather than on Node.

`check:deploy` also requires the generated `dist/worker/wrangler.json` to carry
no Node.js compatibility flag (`nodejs_compat*`, `nodejs_als`). Enabling one
would make Node globals available in the Worker and so hide a real dependency.

### Limits

- **Computed dynamic imports are not statically prohibited.** A specifier built
  from a run-time value (`import(name)`, `"node:" + "fs"`) is not evaluated by any
  layer; its target is a run-time decision. This is a deliberate gap of the
  current stage, not an oversight.
- **`declare global` augmentations are not rejected** by layer 3. If such a
  capability is actually used, layer 4 still sees the emitted reference.
- **`@ts-nocheck` is not prohibited.** Policy names only `@ts-ignore` and
  `@ts-expect-error`; a file-level `@ts-nocheck` would disable layer 2 for that
  file. Review it if it ever appears.
- **Artifact inspection proves only the references it covers.** Layer 4 can show
  that a listed reference is present; it cannot show that no runtime capability
  exists. Generated code that builds a capability without those literal shapes is
  outside its reach.
- Layer 3 is a narrow textual rule set, not a type-aware analysis: it suppresses
  matches inside comments, strings, templates and regexes, but it is not a parser.
- `check:deploy` needs a build. A change that only affects `src/` or `worker/`
  is caught earlier by layers 1–3.

## Get the repository

- **GitHub template workflow:** choose _Use this template → Create a new
  repository_, clone the new repository, then initialise it as described
  below. GitHub copies files verbatim; it does not substitute the identity
  placeholder, so the initialiser is required in this workflow too.
- **Local workflow:** clone or copy this repository, then initialise it.

The directory name chosen by GitHub or your shell is not used as the project
name. Supply the name explicitly. Update the Git remote with
`git remote set-url origin <url>` if needed.

A fresh checkout contains source and configuration only: `node_modules/`,
`dist/`, `build-wasm/`, `public/wasm/` and `.wrangler/` are generated and
ignored.

## Install the toolchain and dependencies

### Install mise and the pinned tools

```bash
curl https://mise.run | sh
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
source ~/.bashrc

mise trust        # trust this project's .mise.toml (first time only)
mise install      # install the versions pinned in .mise.toml
```

The first `mise install` downloads the Emscripten SDK (~1.7 GB) and the pinned
Python distribution, and takes a few minutes. Later checkouts reuse mise's
install and download caches.

| Tool                 | Pinned version | Used for                                                   |
| -------------------- | -------------- | ---------------------------------------------------------- |
| Node.js              | `24.19.0`      | Host for Vite and Wrangler, and for the Node-based scripts and test suites that have not moved to Deno yet |
| Deno                 | `2.9.8`        | Task runner (`deno.json`) and npm dependency installation  |
| CMake                | `4.4.5`        | Configuring the C++26 → WebAssembly build                  |
| Ninja                | `1.13.2`       | CMake generator for the WebAssembly build                  |
| Emscripten (`emsdk`) | `6.0.13`       | C++26 compiler and CMake toolchain                         |
| Python               | `3.13.18`      | Emscripten's Python-based `emcc`/`em++` driver             |

`package.json` declares `engines.node >= 22.12.0` as the minimum supported
Node version. `.mise.toml` pins the exact known-good version for reproducible
builds. CMake is pinned to `4.4.5` because the Emscripten 6.0.13 toolchain
warns for CMake `4.2.0`–`4.3.3`, while [wasm/CMakeLists.txt](wasm/CMakeLists.txt)
requires at least CMake `4.2`.

### Install the npm dependencies

```bash
mise exec -- deno install --frozen
```

Deno installs the dependencies declared in [package.json](package.json) into
`node_modules/`, resolving them through [deno.lock](deno.lock). `--frozen`
makes the install fail if the lockfile is out of date instead of changing it.
The first install needs registry access; Deno's download cache is reused
afterwards.

Deno may report that npm lifecycle scripts were ignored, notably for
`workerd`. On the supported Ubuntu platforms the pinned platform-specific
package supplies the workerd binary used by Wrangler, so this notice does not
prevent builds, tests or dry runs.

After the toolchain and dependencies are installed, the build, tests and
Wrangler dry run do not require network access. Wrangler's update check is
best-effort and time-bounded, so an offline dry run still succeeds.

### Verify the toolchain

```bash
mise exec -- node --version     # v24.19.0
mise exec -- deno --version     # deno 2.9.8
mise exec -- cmake --version    # cmake version 4.4.5
mise exec -- ninja --version    # 1.13.2
mise exec -- emcc --version     # ... 6.0.13 (...)
mise exec -- python3 --version  # Python 3.13.18
```

`mise exec --` runs a command with the pinned tools on `PATH`. The
`node_modules/.bin` shims and `node …` commands therefore use the pinned Node
rather than a host installation.

### Emscripten SDK resolution

`scripts/build.sh` resolves the SDK root in this order, first match wins:

1. `EMSDK_ROOT` — explicit override, for example a shared installation.
2. `EMSDK` — normally exported by mise for the pinned `emsdk` tool.
3. `emcc` on `PATH` — the root is derived from
   `<root>/upstream/emscripten/emcc`.
4. `/opt/emsdk` — documented legacy fallback.

`EMSCRIPTEN_ROOT` is used only if `<resolved-root>/upstream/emscripten` is
missing. Inspect the result without building:

```bash
mise exec -- bash scripts/build.sh --print-emsdk-root
```

The full build also prints `EMSDK_ROOT=…` at stage `[1/9]`. If a different SDK
is intentionally required, set `EMSDK_ROOT`; the CMake cache in `build-wasm/`
detects a toolchain change and triggers a clean reconfigure. The build keeps
the project-managed Node ahead of Emscripten's bundled Node and refuses to run
on the bundled Node.

Emscripten's `emcc`/`em++` drivers are Python programs, and the pinned emsdk
does not bundle an interpreter. `.mise.toml` pins Python 3.13.18; Emscripten
requires Python >= 3.10. `scripts/build.sh` uses `EMSDK_PYTHON` when it is set,
otherwise resolves `python3` (then `python`) from `PATH`, checks the version,
prints the interpreter at `[1/9]`, and exports `EMSDK_PYTHON` so `emcc` and the
compiler invocations made by CMake and Ninja use it. `mise exec` and an
activated mise shell put the pinned Python on `PATH`.

### Environment variables used by the tooling

| Variable | Used by | Purpose |
| --- | --- | --- |
| `EMSDK_ROOT` | `scripts/build.sh` | Explicit Emscripten SDK root override |
| `EMSDK` | `scripts/build.sh` | SDK root normally exported by mise |
| `EMSCRIPTEN_ROOT` | `scripts/build.sh` | Fallback when the expected SDK layout is absent |
| `EMSDK_PYTHON` | `scripts/build.sh`, Emscripten `emcc` | Python interpreter for `emcc`; the build exports the resolved value and respects an explicit override |
| `NODE_BIN` | `scripts/worker-types.sh`, `scripts/deploy.sh` | Explicit Node executable override; normally unset |
| `CLOUDFLARE_API_TOKEN` | Wrangler | Non-interactive Cloudflare authentication |
| `TMPDIR` / `RUNNER_TEMP` | `scripts/ci.sh` | Parent directory for the temporary build copy |
| `MISE_YES`, `DENO_NO_UPDATE_CHECK` | GitHub Actions workflow | Non-interactive tool install and quieter Deno output |

The repository does not contain or require a credentials file.

## Initialise the project

The template stores its identity as a placeholder. Until initialisation the
configured Cloudflare Worker name is not a valid Worker name, so the Vite
Cloudflare plugin and Wrangler reject it: `npm run dev`, `deno task build`,
`deno task check:worker-types` and `deno task deploy` fail on an untouched
template. Initialise once, before any of those commands.

### Commands and options

```bash
# preview every change; writes nothing
mise exec -- node scripts/init-project.mjs my-app --dry-run

# apply
mise exec -- node scripts/init-project.mjs my-app

# placeholder, target files, name rules and exit codes
mise exec -- node scripts/init-project.mjs --help
```

Equivalent task-runner forms:

```bash
mise exec -- deno task init:project my-app --dry-run
mise exec -- npm run init:project -- my-app --dry-run
```

- `--dry-run` / `-n` performs the same validation and prints the intended
  `-`/`+` lines; no files are written.
- `--root DIR` or `--root=DIR` initialises another checkout instead of the
  current directory. Relative paths are resolved from the current directory;
  paths containing spaces are supported. The directory must exist and be a
  directory. Repeating `--root` with a different value is an error. Use
  `--root=DIR` when the directory name itself begins with `-`; a separate
  `--root` value beginning with `-` is treated as a missing argument.
- `--` ends option parsing. Exactly one project name is accepted.
- `--help` / `-h` prints usage and exits `0`.

Unknown options, conflicting duplicate `--root` values and extra positional
arguments are usage errors.

### Project-name rules

The name must be valid as both an npm `package.json` name and a Cloudflare
Worker identity:

- npm: lowercase and URL-safe; only lowercase letters, digits and `.`, `_`,
  `~`, `-`; must not start with `.` or `_`; must not be `node_modules` or
  `favicon.ico`; at most 214 characters.
- Worker: lowercase letters, digits and single hyphens, starting and ending
  with a letter or digit. Underscores, dots, tildes, spaces, slashes,
  uppercase and leading/trailing/repeated hyphens are rejected.
- The service identifier is `<name>-worker`. It must also fit Cloudflare's
  63-character Worker-name limit, so `<name>` may be at most 56 characters.

Validation runs before any project file is read and reports which convention
failed.

### Files updated

| File              | Field                            | Example result               |
| ----------------- | -------------------------------- | ---------------------------- |
| `package.json`    | `name`                           | `"name": "my-app"`           |
| `index.html`      | `<title>`                        | `<title>my-app</title>`      |
| `README.md`       | top-level heading                | `# my-app`                   |
| `worker/index.ts` | `/api/health` service identifier | `"service": "my-app-worker"` |
| `wrangler.jsonc`  | deployed Worker name             | `"name": "my-app"`           |

Only literal placeholder tokens are replaced, exactly once in each of these
five files. Unrelated text, formatting, comments, line endings (LF/CRLF),
missing trailing newlines and file modes are preserved.

### Project states

Initialisation is strict and intended to run once:

- **Untouched template:** every target has exactly one placeholder in its
  identity field and the identity values have the template form. This is the
  only state that is initialised.
- **Already initialised:** no placeholders remain, `package.json` declares a
  valid project name, and all five identity values agree. The command prints
  `Project is already initialised …` and exits `0`; it is a no-op even when a
  different name is requested. An initialised project is never renamed.
- **Partial, customised or inconsistent:** some placeholders remain, identity
  values disagree, the declared name is invalid, a required file is missing,
  unreadable, not a regular file or a symbolic link, a target resolves outside
  the project root, a placeholder is not in its identity field, or a stray
  token is found. The command aborts with exit code `2` and writes nothing.
  Customised values are never overwritten or repaired.

To rename an initialised project, edit the five identity files manually or
start again from a fresh template.

### Stray-token scan exclusions

Before writing, the initialiser scans the repository for placeholders outside
the five targets. The token is ignored in:

- the initialiser's own tooling file(s);
- binary files (files containing a NUL byte);
- generated/ignored directories: `node_modules`, `dist`, `build-wasm`,
  `.wrangler` and `.git`;
- in a Git checkout, files ignored by Git (the scan uses `git ls-files`,
  including untracked files that are not ignored).

A token in any other file aborts initialisation. Do not copy generated output
or editor state into a template.

### Safety guarantees

Initialisation is a two-phase operation:

1. **Validation:** read and validate the project state and build every
   replacement in memory. Nothing is written.
2. **Commit:** stage new contents in temporary files next to their targets,
   preserve the target mode, then rename each staged file into place.

Each individual rename is atomic, but the five-file update is **not** a single
transaction. If a later write fails, files renamed before it already contain
the new contents; they are restored from the in-memory originals in reverse
order. Rollback is best effort and can itself fail (for example if a directory
becomes read-only), in which case the error names the files that may be
partially initialised. Temporary files are removed on success, and on failure
where removal is possible.

The filesystem checks are point-in-time. Initialisation does not lock the tree
against concurrent modification, and Node has no `renameat`/`openat`
equivalent, so a directory replaced by a symbolic link during the run can
redirect a later write. Run initialisation on a tree that is not being
modified concurrently.

Because all validation completes before the first write, an invalid name, a
missing or unexpected placeholder, a stray token, or a partial, customised or
inconsistent project leaves every file byte-for-byte unchanged. `--dry-run`
performs the same validation and writes nothing.

### Exit codes

| Code | Meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| `0`  | Initialised, dry run, or already initialised (no-op)                                                     |
| `1`  | Usage or project-name validation error                                                                   |
| `2`  | Project state error: missing/unreadable/redirected file, placeholder or identity problem, or stray token |
| `3`  | Staging, renaming or rollback failed                                                                     |

Expected usage, name and state errors are reported as messages, not stack
traces.

### Initialisation is required before build and deployment

The placeholder is deliberately not a valid Cloudflare Worker name. Wrangler
and the Cloudflare Vite plugin reject it, so the development server, build,
Worker types check and deployment all fail on an untouched template. This is
intentional: an uninitialised copy cannot be built or deployed by accident.

The initialiser is safe to leave in place; repeat runs are no-ops. If you
remove it after initialising, delete `scripts/init-project.mjs` and
`scripts/init-project.test.mjs`, remove the `init:project` / `test:init`
entries from `package.json` and `deno.json`, and update `scripts/ci.sh`, which
invokes the initialiser when preparing its throwaway build copy. Keep the rest
of this documentation if it remains useful.

## Build and develop

### Main components

| Path | Responsibility |
| --- | --- |
| `src/` | Browser application (TypeScript, CSS, assets); `src/main.ts` loads the WASM module and drives the UI |
| `worker/` | Cloudflare Worker (`index.ts`) and its direct handler tests (`index.test.mjs`) |
| `wasm/` | C++26 source, [CMakeLists.txt](wasm/CMakeLists.txt) and the build-tree smoke test |
| `public/` | Static assets served by Vite; `public/wasm/` is generated |
| `wrangler.jsonc` | Worker entry, deployed name placeholder, compatibility date, source maps, asset binding, SPA fallback and `/api/*` routing |
| `vite.config.ts` | Vite plus `@cloudflare/vite-plugin`: client and Worker environments, Worker source maps |
| `scripts/` | Build, Worker types, deployment, CI, initialiser, deployment-artefact checker and their tests |
| `.mise.toml`, `deno.json`, `package.json`, `deno.lock` | Pinned tools, task definitions and the locked dependency graph |
| `worker-configuration.d.ts` | Generated, tracked Worker `Env` types; never edit by hand |

### Development server

```bash
mise exec -- npm run dev
# choose another port:
mise exec -- npm run dev -- --port 5199
```

This starts Vite with the Cloudflare plugin and a local Worker runtime. It needs
an initialised project but no Cloudflare account or credentials. Worker code
and client code are served from source; nothing is deployed.

### Full build

```bash
mise exec -- deno task build
# equivalent convenience script:
mise exec -- npm run build
```

`scripts/build.sh` performs nine printed stages:

1. Resolve and initialise the Emscripten SDK, keep the project-managed Node
   first on `PATH` for the Vite and Wrangler shims, and verify `em++`, `cmake`,
   `ninja`, the Python interpreter and the installed npm dependency tree
   (`tsc`, `vite`, `wrangler`) are available.
2. Configure CMake with the Emscripten toolchain.
3. Build the C++ sources with Ninja.
4. Publish the build-tree `wasm_math.js` and `wasm_math.wasm` to
   `public/wasm/`.
5. Type-check the client with the TypeScript 7 checker (launched by Deno).
6. Type-check the Worker with the same checker.
7. Check that `worker-configuration.d.ts` is current.
8. Remove `dist/` and run the Vite production build for the Worker and client.
9. Run the published-artefact WASM smoke test.

The build fails early with an explicit message if the npm dependencies are
missing (`mise exec -- deno install --frozen`), if the Emscripten SDK cannot be
resolved, or if a suitable Python interpreter is unavailable.

#### C++ language standard

The WASM target is compiled as C++26.
[wasm/CMakeLists.txt](wasm/CMakeLists.txt) sets `CMAKE_CXX_STANDARD 26` with
`CMAKE_CXX_STANDARD_REQUIRED ON` and `CMAKE_CXX_EXTENSIONS OFF`; the generated
Ninja compile flag is `-std=c++26`. Emscripten 6.0.13's Clang accepts the flag
and reports `__cplusplus 202400L`, and CMake 4.4.5 supports `CXX_STANDARD 26`.
The current sources do not use C++26-specific features merely to demonstrate
the mode; the available C++26 support is whatever the pinned compiler
provides.

#### WebAssembly publication

The CMake target produces modularised ES6 JavaScript and a companion `.wasm`
binary. `scripts/build-wasm.sh` validates and republishes both to
`public/wasm/` on every build; Vite copies the public directory into
`dist/client/`, so the browser loads `/wasm/wasm_math.js` from the final client
assets. `deno task test:wasm` loads the build-tree module;
`deno task test:wasm:published` loads the final `dist/client` module. Both run
on Deno with the Node globals hidden and a browser-like `window` declared, and
both instantiate the module, call `_add(19, 23)` and expect `42`.

#### Worker, Vite and Wrangler

The Cloudflare Vite plugin builds the Worker bundle and the client assets in
one Vite run. It also writes a resolved deployment configuration to
`dist/worker/wrangler.json`, including `main: "index.js"`, the asset directory
`../client`, `no_bundle: true` and the routing settings from `wrangler.jsonc`.
`wrangler deploy` uses that generated configuration, so the uploaded Worker is
the bundle that was built and tested, not a fresh re-bundle.

`wrangler.jsonc` routes `/api/*` to the Worker first and uses
single-page-application fallback for other asset requests. The Worker handles
`/api/health`; its unit tests exercise the handler directly, while routing is
verified statically and by the deployment dry run (see
[Test and validate](#test-and-validate)).

#### Worker type generation

`worker-configuration.d.ts` contains the generated `Env` interface and runtime
types. After changing bindings or `wrangler.jsonc`, regenerate it and review
the diff:

```bash
mise exec -- deno task types:worker
mise exec -- deno task check:worker-types   # freshness check used by the build
```

The file is tracked, excluded from formatting and linting, and must not be
edited by hand. Both commands require an initialised project.

### Cold and incremental builds

- The first build configures and compiles the CMake tree in `build-wasm/`.
- Later builds reuse `build-wasm/`; Ninja recompiles only changed sources.
- `dist/` is deleted and recreated on every build, so stale Vite output cannot
  survive.
- `public/wasm/` is republished from the build tree on every build.
- If `build-wasm/CMakeCache.txt` records a different Emscripten toolchain from
  the one resolved now, `scripts/build-wasm.sh` removes `build-wasm/` and
  reconfigures from scratch.

To inspect the SDK the build would use without building anything:

```bash
mise exec -- bash scripts/build.sh --print-emsdk-root
```

### Generated and ignored files

| Path | Kind | Notes |
| --- | --- | --- |
| `dist/` | Generated | Final deployment artefacts; ignored and recreated by every build |
| `dist/client/` | Generated | `index.html`, hashed assets, `wasm/` and `.assetsignore` |
| `dist/worker/` | Generated | Worker bundle, source map and generated `wrangler.json` |
| `build-wasm/` | Generated | CMake/Ninja build tree; ignored; reused incrementally |
| `public/wasm/` | Generated | Intermediate WASM publication; ignored |
| `node_modules/` | Generated | Installed dependencies; ignored |
| `.wrangler/` | Local state | Wrangler working state; ignored |
| `worker-configuration.d.ts` | Generated, tracked | Worker types; regenerate with `types:worker` |
| `deno.lock` | Tracked | Lockfile; change only through Deno when dependencies change |

## Test and validate

Run these from the project root with dependencies installed. Commands marked
"build required" use output from `deno task build` and fail if it is missing.

| Command | What it checks | Prerequisites |
| --- | --- | --- |
| `deno task fmt` / `fmt:check` | Formatting; `fmt` writes, `fmt:check` does not | Toolchain |
| `deno task lint` | Deno lint rules | Toolchain |
| `deno task check:client` | Client TypeScript semantics (TypeScript 7 native checker, launched by Deno) | Dependencies |
| `deno task check:worker` | Worker TypeScript semantics (same checker, `worker/tsconfig.json`) | Dependencies |
| `deno task check:node-boundary` | Configuration invariants plus the narrow source policy (`node:`/`cloudflare:` ambient declarations, suppression directives) | Node |
| `deno task test:init` | Initialiser unit tests in temporary fixtures | Node |
| `deno task test:worker` | Worker handler tests, invoked directly | Node |
| `deno task test:scripts` | Emscripten SDK-root resolution tests with fake layouts | Node and Bash |
| `deno task test:deploy` | Deployment-artefact checker unit tests in temporary fixtures | Node |
| `deno task test:boundary` | Invariants and source-policy rules, including negative canaries and Worker typecheck coverage | Node |
| `deno task check:worker-types` | `worker-configuration.d.ts` is current | Initialised project, dependencies |
| `deno task types:worker` | Regenerates `worker-configuration.d.ts` (writes) | Initialised project, dependencies |
| `deno task test:wasm` | Build-tree WASM smoke test on Deno, Node globals hidden (`19 + 23 = 42`) | Build required |
| `deno task test:wasm:published` | Published (`dist/client`) WASM smoke test on Deno (`19 + 23 = 42`) | Full build required |
| `deno task check:deploy` | Generated config/artefact consistency, symlink containment and the Node boundary in the emitted bundles | Full build required |
| `deno task deploy:dry-run` | Build, artefact check and `wrangler deploy --dry-run` | Initialised project, dependencies |
| `deno task validate` | `fmt:check`, `lint`, client/Worker typechecks, the Node boundary check and the five Node test suites | Dependencies; works on the template |
| `deno task ci` | `scripts/ci.sh all` (static checks plus isolated build validation) | Dependencies; works on the template |

Deno tasks are canonical. `package.json` provides npm script equivalents for
many of them (`npm run build`, `npm run test:wasm`, `npm run check:deploy`,
and so on), but the deployment and Worker-type tasks are available as Deno
tasks only.

### `scripts/ci.sh` modes and `deno task ci`

The modes can be run directly with the pinned toolchain:

```bash
mise exec -- bash scripts/ci.sh static
mise exec -- bash scripts/ci.sh build
mise exec -- bash scripts/ci.sh all
```

`deno task ci` runs `bash scripts/ci.sh` with no argument, which is the `all`
mode:

| Mode | Work performed |
| --- | --- |
| `static` | Formatting, linting, client and Worker typechecks, the Node dependency-boundary check and tests, initialiser tests, Worker runtime tests |
| `build` | Build/deployment tooling tests, dependency check, throwaway build copy, throwaway identity, Worker types freshness, full build, deployment-artefact check, both Deno WASM smoke tests, Wrangler dry run |
| `all` | `static` followed by `build` (the default) |

The checkout is never modified. The build mode copies the working tree
(including uncommitted changes) to a temporary directory, leaving out Git
metadata, dependencies and generated output (`.git`, `node_modules`, `dist`,
`build-wasm`, `.wrangler`, `public/wasm`), symlinks the existing `node_modules`,
and removes the copy on exit. It initialises the copy as `ci-smoke`; if the
source is already initialised that step is a no-op, so the copy keeps the
existing identity.

The `static` mode does not include `test:scripts` or `test:deploy`; those run
at the start of the `build` mode. `deno task validate` does include both.
`scripts/ci.sh build` needs `node_modules`; the explicit dependency check
prints the install command if it is missing. Run `deno install --frozen` before
either mode that performs typechecks or builds.

### What is not tested

- Worker runtime tests call the exported `fetch` handler directly with
  `Request` objects. They do not start workerd, a local server or a network
  listener, and they do not exercise Cloudflare asset serving,
  `run_worker_first`, SPA fallback or custom domains.
- Asset routing is checked by static configuration inspection and
  `wrangler deploy --dry-run`, not by live HTTP requests.
- WASM smoke tests execute on Deno in a browser-like profile (Node globals
  removed, `window` declared), not in a real browser. The harness shows the
  module needs no Node runtime and loads from a browser-shaped environment; it is
  not a browser-behaviour test. With `-sENVIRONMENT=web` the glue refuses to load
  under Node at all, so the former Node smoke tests no longer exist.
- The Node dependency-boundary checks are textual. They detect Node imports and
  Node globals in application source and in the emitted bundles, but they do not
  prove the absence of a Node dependency at run time, and they do not inspect
  `node_modules`.
- `check:deploy` is a point-in-time static check; it does not protect against
  files or directories being replaced between the check and the upload.
- `wrangler deploy --dry-run` validates and packages the configuration and
  assets but performs no upload and no live routing test.
- No real deployment or post-deployment smoke test is performed by the
  repository or CI.
- No native Windows, macOS or `/mnt/c` build is exercised.

## Deploy

A real deployment requires an initialised project, installed dependencies and
Cloudflare authentication; dry runs need no credentials. The repository never
contains credentials or account state.

### Authentication

Wrangler accepts either an interactive login:

```bash
mise exec -- node node_modules/wrangler/bin/wrangler.js login
```

or a `CLOUDFLARE_API_TOKEN` in the environment. Use an interactive login on a
developer machine, or provide the token through your normal secret mechanism
in an automation environment. Never commit tokens, `.env` files or Wrangler
account state.

A real deployment needs a Cloudflare account with permission to deploy the
Worker; a dry run does not.

### Commands

```bash
# build, validate the deployment artefacts, then package without uploading
mise exec -- deno task deploy:dry-run

# build, validate, then deploy
mise exec -- deno task deploy

# validate an existing build without invoking Wrangler
mise exec -- deno task check:deploy
```

`deploy:dry-run` requires no Cloudflare credentials. `check:deploy` requires a
completed build.

### What the deployment command does

`scripts/deploy.sh`:

1. Runs `deno task build`.
2. Confirms that the generated configuration
   `dist/worker/wrangler.json` exists.
3. Runs `scripts/check-deploy-artifacts.mjs` against the generated artefacts.
4. Runs Wrangler with that generated configuration.

Extra arguments are passed through to Wrangler; this is how the
`deploy:dry-run` task adds `--dry-run`.

The artefact checker verifies that:

- the generated Worker name matches `package.json`;
- `no_bundle` is set, so the tested Worker bundle is uploaded unchanged;
- the generated config, Worker `main`, assets directory, `index.html`, both
  published WASM files and the source map (when enabled) exist and resolve
  inside the real `dist/` tree, including after resolving symbolic links;
- the asset binding, SPA fallback and `run_worker_first` routing are present;
- the generated configuration enables no Node.js compatibility flag, and the
  Worker bundle, the client bundles and the published WASM glue stay within the
  Node dependency boundary (see
  [Node.js dependency boundary](#nodejs-dependency-boundary)).

It rejects artefacts that escape `dist/` through symlinks, but it is a
point-in-time check. It does not protect against concurrent changes between the
check and the upload.

### Generated deployment artefacts

| Path | Contents |
| --- | --- |
| `dist/client/` | Final client assets: `index.html`, hashed JS/CSS/images and `wasm/` |
| `dist/client/wasm/` | Published WASM JavaScript and binary used by the browser |
| `dist/worker/index.js` | Built Worker bundle uploaded by Wrangler |
| `dist/worker/index.js.map` | Worker source map, uploaded while `upload_source_maps` is enabled |
| `dist/worker/wrangler.json` | Vite-plugin-generated deployment configuration used by Wrangler |

Do not edit files under `dist/`; they are regenerated by every build.

### Dry run versus a real deployment

`wrangler deploy --dry-run` compiles and validates the configuration, reads the
asset directory, and packages the Worker, but does not authenticate, upload,
create a version or route traffic. A successful dry run therefore proves that
the build and generated configuration are internally consistent and accepted
by Wrangler; it does not prove that credentials are valid, that a real upload
will succeed, or that the deployed application will answer requests as
expected.

`mise exec -- deno task deploy` performs the same build and artefact checks and
then runs Wrangler without `--dry-run`. Wrangler reports missing or invalid
credentials. In a non-interactive environment it requires
`CLOUDFLARE_API_TOKEN`; interactively, use `wrangler login`. The diagnostic
comes from Wrangler; this repository does not store or broker credentials.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pushes to
`main` and pull requests targeting `main`. It uses `ubuntu-24.04` with a
30-minute timeout, read-only `contents` permission and concurrency that
cancels an older run for the same branch.

The workflow:

1. Checks out the repository without persisting credentials.
2. Installs the pinned toolchain with `jdx/mise-action`, caching mise's install
   and download directories (including the Emscripten SDK and Python) under a
   key derived from `.mise.toml`. The post-step save also captures Emscripten's
   compiler cache.
3. Verifies the pinned Node, Deno, CMake, Ninja, Emscripten and Python
   versions.
4. Caches `~/.cache/deno` under a key derived from `deno.lock`.
5. Installs dependencies with `deno install --frozen`.
6. Runs formatting, linting, client/Worker typechecks, initialiser tests and
   Worker runtime tests individually.
7. Runs `scripts/ci.sh build` in a throwaway initialised copy.

The raw template is statically checked because its placeholder is not a valid
Worker name. Build validation therefore happens in the throwaway copy:
tooling tests, Worker types freshness, full build, deployment-artefact check,
both Deno WASM smoke tests and the Wrangler dry run. CI has no Cloudflare secrets
and never deploys.

For a local equivalent, run `mise exec -- deno task validate` for the static
checks and `mise exec -- deno task ci` for static plus build validation. The
workflow runs the individual static steps and `scripts/ci.sh build`, rather
than invoking `scripts/ci.sh all` itself.

## Troubleshooting

### `mise install` is slow or fails

The first Emscripten SDK download is ~1.7 GB and needs network access. Ensure
`mise` is trusted (`mise trust`) and that the host has enough disk space.
Later installs reuse mise's caches.

### An untouched template refuses to start, build or deploy

This is expected. The placeholder is not a valid Worker name. Run the
initialiser first; on a fresh template, `npm run dev` surfaces the Wrangler
validation error as a stack trace rather than a one-line message.

### The build uses an unexpected Emscripten SDK

Check the resolved root without building:

```bash
mise exec -- bash scripts/build.sh --print-emsdk-root
```

The normal build also prints `EMSDK_ROOT=…` at stage `[1/9]`. See
[Emscripten SDK resolution](#emscripten-sdk-resolution) for the resolution
order; set `EMSDK_ROOT` to select a specific SDK explicitly.

### The build cannot find Python

Emscripten's compiler driver is Python. `mise install` installs the pinned
Python 3.13.18; check it with:

```bash
mise exec -- python3 --version
```

The build prints `python 3.13.18 (<path>)` at stage `[1/9]`. Emscripten requires
Python >= 3.10. If `EMSDK_PYTHON` is set, the build respects it; otherwise it
uses `python3` or `python` from `PATH`.

### The build says npm dependencies are missing

Install them with:

```bash
mise exec -- deno install --frozen
```

The build checks for `node_modules/.bin/tsc`, `vite` and `wrangler` before
starting the WASM work. `tsc` is checked as evidence that the dependency tree
was installed; type checking itself is launched through Deno. The build also
requires `deno` on `PATH` for those typechecks and for the published WASM smoke
test, and stops with an install hint if it is absent.

### `check:worker-types` fails

The generated `worker-configuration.d.ts` is stale. Regenerate and review it:

```bash
mise exec -- deno task types:worker
git diff -- worker-configuration.d.ts
```

The freshness check requires an initialised project because Wrangler rejects
the template placeholder.

### The WASM build reconfigures from scratch

If the Emscripten toolchain path recorded in `build-wasm/CMakeCache.txt`
differs from the currently resolved one, `scripts/build-wasm.sh` removes and
reconfigures `build-wasm/`. This is intentional; it prevents a stale SDK from
being reused. `dist/` is also recreated on every full build.

### `deno install --frozen` fails

The lockfile and `package.json` disagree. Update the lockfile intentionally
(for example with `mise exec -- deno install`), review the change to
`deno.lock`, and commit it with the dependency change. Do not bypass
`--frozen` in CI.

### WSL: permission, executable-bit or symlink errors

Move the checkout into the Linux filesystem (for example `~/src/...`) and rerun
the command. Builds from `/mnt/c` are outside the supported environment.

### Deployment authentication fails

For an interactive session, run `wrangler login` through the pinned Node:

```bash
mise exec -- node node_modules/wrangler/bin/wrangler.js login
```

For non-interactive use, set `CLOUDFLARE_API_TOKEN` through your normal secret
mechanism. A dry run does not need either.

## Template maintenance

The initialiser's tests live in `scripts/init-project.test.mjs`:

```bash
mise exec -- deno task test:init
```

If you add another file that carries project identity, add the placeholder to
it, list it in `TARGETS` at the top of `scripts/init-project.mjs` with its
expected occurrence count, extend the table in
[Files updated](#files-updated), and update the identity extractor if the new
field is not one of the existing kinds.

To offer this repository as a GitHub template, enable **Settings → General →
Template repository** once. The _Use this template_ button copies files
verbatim; new projects still run the initialiser.

Formatting and linting use Deno's built-in tools from
[deno.json](deno.json). `worker-configuration.d.ts` is excluded from both
because it is generated, and [README.md](README.md) is excluded from the
formatter because Deno's Markdown formatter would rewrite the identity
placeholder. The README is maintained by hand. All other supported files are
covered by `deno task fmt:check` and `deno task lint`.

The "Get the repository", "Initialise the project" and "Template maintenance"
material can be trimmed once a project is initialised; the operational build,
test, deployment and CI sections remain useful.
