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

If mise is activated in your shell, the plain `deno task build` form works too.

## Quick start

Once mise is installed (see
[Install the toolchain and dependencies](#install-the-toolchain-and-dependencies)),
the shortest path is:

```bash
mise trust
mise install
mise exec -- deno task toolchain:specify -- --deno 2.9.8 --vite 8.3.5 \
  --wrangler 4.156.0 --emscripten 6.0.13
mise install
mise exec -- deno task toolchain:install
mise exec -- deno task init:project my-app --dry-run
mise exec -- deno task init:project my-app
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
- a Cloudflare account for a real deployment (not for builds or dry runs);
- no Node.js. Every workflow — build, validation, tests, development, preview,
  dry run and deployment — runs under the pinned Deno.

The repository provides the pinned tools through [`.mise.toml`](.mise.toml), the
dependency graph through [deno.lock](deno.lock), and the build, test and
deployment scripts. Python is expected from the host rather than pinned — see
[Emscripten SDK resolution](#emscripten-sdk-resolution). No credentials, secrets or
Cloudflare account state are stored in the repository.

No Dockerfile or dev-container configuration is included. Any Linux
environment that provides the host requirements can use the repository.

## Runtime ownership

Dependencies fall into four categories, and a runtime requirement in one must
not become a requirement in another.

| Category | Members | Runtime required | Supplied by |
| --- | --- | --- | --- |
| Encapsulated toolchain | Emscripten 6.0.13 and everything it drives | its own Node, LLVM, Binaryen; the host's Python | the toolchain itself; the host for Python |
| External ecosystem | Vite 8.3.5 (Rolldown, lightningcss), Wrangler 4.156.0 (workerd, esbuild, miniflare) | Deno, for the Vite build, the development and preview servers, Wrangler type generation, dry-run and deployment | this project (packages) |
| Project-owned infrastructure | Bash orchestration, Deno tasks, Deno Vite/Wrangler launchers, initialisation, boundary/deployment checks and tests, Deno WASM harness, CI | Deno | this project |
| Delivered application | browser bundle, Worker bundle, WASM glue | browser / Worker capabilities only | this project |

### Encapsulated toolchain dependencies

Emscripten 6.0.13 is a self-contained SDK for its compiler internals. It ships
and pins **its own** Node 24.19.0 — `NODE_JS` is an absolute path in its private
`.emscripten` configuration — and uses it internally for `tools/compiler.mjs`,
`tools/preprocessor.mjs` and the JavaScript optimiser. That Node is private to
the SDK: it is not declared in [`.mise.toml`](.mise.toml), it is not offered to
project-owned execution, and this project never invokes it directly. LLVM,
Binaryen, CMake and Ninja belong to the toolchain in the same way.

Python is the exception: the SDK drives `emcc`/`em++` through a Python
interpreter it does **not** bundle, so Python is a host prerequisite that only
becomes a project-provisioned fallback when the host cannot satisfy it.

### External ecosystem tools

Vite 8.3.5 and Wrangler 4.156.0 are Node-oriented packages, but their runtime
requirements differ in this project. The Vite production build, Wrangler type
generation and Wrangler dry-run run in separate Deno processes through
`scripts/vite-build.mjs`, `scripts/wrangler-types.mjs` and
`scripts/wrangler-dry-run.mjs`. Rolldown and lightningcss are native N-API
bindings loaded with path-scoped Deno FFI permission; Wrangler types use scoped
workerd and esbuild executables; dry-run uses only scoped esbuild. Real Wrangler
deployment is invoked through `scripts/wrangler-deploy.mjs` under Deno with a
narrow profile: read, env, sys, write limited to its own `.wrangler` state and
logs (including the generated `dist/worker/.wrangler`), scoped esbuild and
`api.cloudflare.com`. No host Node is used for deployment, the Vite build, or
the development and preview servers. Emscripten has its own embedded Node,
private to the SDK. This is a deliberate external-tooling dependency, not a
claim that the application needs Node.

Vite runs under one of two named permission profiles. `local` is the default and
the only profile a developer machine uses: read, write, env and sys, plus
path-scoped FFI for the Rolldown and lightningcss bindings, and no run or net
permission. `ci-runner` grants `--allow-all` to the separate Vite child process
only: an ephemeral GitHub-hosted runner is trusted CI code, and Deno's sandbox
currently refuses Vite's Linux platform detection when it probes special procfs
paths such as `/proc/sys/fs/binfmt_misc/WSLInterop` under scoped permissions
([denoland/deno#37062](https://github.com/denoland/deno/issues/37062)), failing
the build with `NotCapable`. The launcher invocation in
`scripts/build.sh` stays read-only in both cases, and the profile is always
named explicitly — `scripts/ci.sh` sets `VITE_PERMISSION_PROFILE=ci-runner` for
both builds it performs in its throwaway copy (the initial build and the rebuild
inside `deploy:dry-run`), and nothing infers a profile from `CI` or any other
ambient variable. Both profiles are recorded in the permission contract, so
changing either one changes the launcher-permissions fingerprint and requires a
refresh and review. The broader profile is a temporary
workaround: remove it once the upstream issue is fixed and the build passes with
the restricted local profile.

TypeScript is different in kind. Its semantic checker is a **native Go
executable**; the `tsc` npm entry point is a launcher that resolves that
executable and hands over to it. The launcher is not the semantic engine, so
the checker runs through Deno (`deno task check:client`,
`deno task check:worker`) against the same `tsconfig.json` files, producing the
same diagnostics and exit codes without involving the project Node.

That handover uses `node:child_process`, and Deno provides no `process.execve`,
so `execFileSync` is always the path taken. The spawn therefore needs
`--allow-run`, and Deno accepts only an **exact executable path** for a scoped
run permission — a directory prefix, a relative path and the bare name `tsc` are
all refused. That path is version- and platform-stamped
(`@typescript/typescript-<platform>/lib/tsc`) and is only knowable at run time,
so the typecheck tasks keep an unrestricted `--allow-run` rather than growing a
launcher layer to compute it. The residual authority is recorded rather than
hidden: the pinned, lock-verified `typescript@7.0.2` launcher may start any
executable, and it starts exactly the resolved native compiler. If Deno
implements `process.execve`, the permission can be dropped entirely.

### Project-owned infrastructure

Deno is the runtime for all project-owned infrastructure: the task runner,
formatter/linter, TypeScript launcher, Vite, Wrangler-types and Wrangler dry-run
launchers, initialiser, boundary/deployment checks and tests, test suites and the
WASM harness. Subprocesses are executed with `Deno.Command`; the tests construct
a replacement environment explicitly with `clearEnv: true` where that is intended
and check every exit status. The Bash scripts remain thin orchestration around
Deno and the remaining external real-deployment path.

### Delivered application capabilities

The browser application and the Cloudflare Worker may use only the capabilities
of their own runtimes. Node and Deno are both unavailable to them; that boundary
is enforced by the checks described in
[Node.js dependency boundary](#nodejs-dependency-boundary).

### Deno executes every project workflow

Node is neither installed by [`.mise.toml`](.mise.toml) nor used to execute any
project workflow. Two Node provenances remain, and neither runs project code:

| Provenance | Role | Controlled by |
| --- | --- | --- |
| Emscripten's bundled Node | Private to the SDK; drives `emcc` internals through an absolute `NODE_JS` path | Emscripten 6.0.13 |
| Project-owned Deno execution | Tasks, tests, checks, the Vite build, the development and preview servers, Wrangler type generation, dry-run, deployment and CI | Deno, under the PATH tripwire below |

`deno task dev`, `deno task preview` and `deno task deploy` all run under Deno,
through toolchain-owned launchers that resolve the real `workerd`, `esbuild` and
native bindings and grant only what each mode needs. There is no Node-hosted
alternative and no `package.json` script that starts one.

### Node-exclusion policy

Project-owned execution uses `scripts/deno-no-node.sh` as a common PATH
tripwire. It prepends a temporary directory containing failing `node` and
`nodejs` shims, then executes the supplied command. An attempted command-name
Node invocation prints a diagnostic and exits 127. The wrapper preserves the
rest of PATH, argument forwarding, exit status and the caller's shell
environment.

The wrapper is applied to every project-owned task, including the top level of
`deno task validate` and `deno task ci`. `validate` is wrapped as a whole rather
than relying on its children alone, so a task added to the chain later does not
escape the policy. When a wrapped task starts another wrapped task, the
`DENO_NO_NODE_ACTIVE` marker makes the inner invocation run the command directly
instead of nesting a second tripwire. `scripts/build.sh`, `scripts/ci.sh`,
`scripts/deploy-dry-run.sh` and `scripts/worker-types.sh` also enter the wrapper
when invoked directly, so the shell entry points and the Deno tasks behave
identically. `deno task test:no-node` exercises the tripwire.

`scripts/vite-build.mjs`, `scripts/wrangler-types.mjs` and
`scripts/wrangler-dry-run.mjs` are internal launchers for those wrapped scripts,
not standalone entry points; they are invoked by `scripts/build.sh`,
`scripts/worker-types.sh` and `scripts/deploy-dry-run.sh` respectively.

This is not an OS sandbox. It catches `node`/`nodejs` resolved through PATH. It
does not catch an absolute path such as `/usr/bin/node`, a command that replaces
PATH itself, native code or FFI libraries that launch Node internally, or
Emscripten's embedded Node. The `DENO_NO_NODE_ACTIVE` marker is a recursion
guard, not an unforgeable token: a caller that sets it skips the wrapper.

There are no Node execution exceptions: `scripts/deploy.sh`, `scripts/serve.sh`
and every other task enter the tripwire, and each is wrapped by its Deno task as
well, so a direct invocation and the task behave identically.

## Node.js dependency boundary

Node.js is part of the toolchain, not part of the product. Two things that are
easy to confuse are treated differently:

- **The delivered application** — `src/`, `worker/` and everything the build
  emits into `dist/` — runs in a browser and on Cloudflare Workers. It must not
  import a Node built-in module, read a Node global, or rely on CommonJS.
- **The development toolchain** — the Bash and Deno scripts in `scripts/`,
  `vite.config.ts`, and the external Vite/Wrangler/TypeScript packages whose
  versions are declared in `package.json` and locked in
  [deno.lock](deno.lock) — is not governed by this boundary. The Vite build, the
  development and preview servers, Wrangler type generation, dry-run and
  deployment all run under Deno; Emscripten brings its own Node. See
  [Runtime ownership](#runtime-ownership).

The policy is therefore narrower than "this repository is Node-free": **Node is
not a project-managed tool, and project-owned execution does not depend on it,
but external tools may still require it and project-owned application code and
the delivered application must not acquire a functional dependency on Node.js or
its standard library.**

### What is enforced

The boundary is enforced by three mechanisms, each proving something different:

| # | Mechanism | Scope | Where it runs |
| --- | --- | --- | --- |
| 1. Configuration invariants | `deno task check:contracts` | Recomputes the contract facts and compares them with the committed lock: installed toolchain, both `tsconfig.json` libraries, Wrangler's compatibility settings and the declared launcher permission profiles. Performs no derivation | `validate`, `scripts/ci.sh`, CI |
| `deno task test:contracts` | Contract unit tests — canonical fingerprints, provenance rules, refresh determinism, drift detection and verification helpers — on synthetic fixtures | Deno |
| `deno task check:node-boundary` | `package.json`, `deno.lock`, both `tsconfig.json` files, `wrangler.jsonc` | `validate`, `scripts/ci.sh static`, CI |
| 2. Compiler diagnostics | `deno task check:client`, `check:worker` | `src/`, every `worker/*.ts` module | `validate`, `scripts/ci.sh static`, CI |
| 3. Delivered artefacts | `deno task check:deploy` | `dist/worker`, `dist/client`, published WASM glue, generated Wrangler configuration | `scripts/ci.sh build`, `deno task deploy`, CI |

`deno task test:boundary` tests mechanism 1 (including negative canaries and a
Worker-typecheck coverage canary for mechanism 2); `deno task test:deploy` tests
mechanism 3. Source text is deliberately not scanned: textual matching cannot
tell a capability from a mention of one, and a home-grown tokeniser would imply
semantic assurance it cannot provide. The compiler resolves the program, and
`check:deploy` inspects what is actually shipped.

**1. Configuration invariants.** The type checker enforces the boundary
only because Node's ambient types are absent. Those assumptions are asserted
explicitly, because a check that depends on configuration must verify its own
premise:

- no `package.json` dependency section depends on `@types/node`;
- `deno.lock` does not pin `@types/node`;
- the client `tsconfig.json` declares `types: ["vite/client"]`;
- `worker/tsconfig.json` declares `types: []`;
- no `lib` entry names a Node library;
- `wrangler.jsonc` enables no `nodejs_compat*` flag (the generated configuration is
  checked again by mechanism 3).

**2. Compiler diagnostics.** The compiler resolves imports, aliases and
ambient declarations, and reports `node:fs` as `TS2591` and `process` as
`TS2591`/`TS7017` in both projects. `worker/tsconfig.json` includes
`./**/*.ts`, so a new Worker module is typechecked instead of being silently
ignored.

**3. Delivered artefacts.** Emitted bundles are checked for `node:`
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

- **Source text is not scanned.** An ambient `declare module "node:*"` that is
  never imported, and an authoring-time `@ts-ignore`, are not reported. Their
  delivered consequence has to reach an emitted bundle to matter, and mechanism 3
  inspects those; what is lost is early feedback, not the boundary itself. A
  deliberate `@ts-nocheck` would disable mechanism 2 for one file — review it if
  it ever appears.
- **Computed dynamic imports are not statically prohibited.** A specifier built
  from a run-time value (`import(name)`, `"node:" + "fs"`) is not evaluated by any
  mechanism; its target is a run-time decision. This is a deliberate gap, not an
  oversight.
- **`declare global` augmentations are not rejected.** If such a capability is
  actually used, mechanism 3 still sees the emitted reference.
- **Artifact inspection proves only the references it covers.** Mechanism 3 can
  show that a listed reference is present; it cannot show that no runtime
  capability exists. Generated code that builds a capability without those literal
  shapes is outside its reach. A reference that a bundler defines away — for
  example a `process.env` expression replaced at build time — never appears in the
  emitted bundle at all.
- `check:deploy` needs a build. A change that only affects `src/` or `worker/` is
  caught earlier by mechanisms 1 and 2.

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

The first `mise install` downloads the Emscripten SDK (~1.7 GB) and takes a few
minutes. Later checkouts reuse mise's install and download caches.

| Tool                 | Pinned version | Used for                                                   |
| -------------------- | -------------- | ---------------------------------------------------------- |
| Deno                 | `2.9.8`        | Task runner, formatter/linter, test runner, project-owned scripts, Vite/Wrangler-types/Wrangler-dry-run launchers and the TypeScript launcher |
| CMake                | `4.4.5`        | Configuring the C++26 → WebAssembly build                  |
| Ninja                | `1.13.2`       | CMake generator for the WebAssembly build                  |
| Emscripten (`emsdk`) | `6.0.13`       | C++26 compiler and CMake toolchain; supplies its own Node |
| Python               | *host-provided* | Emscripten's Python-based `emcc`/`em++` driver            |

Python is a **host prerequisite**, not a project-managed tool. Emscripten owns
the requirement, read from the SDK's own `emcc.py` assertion rather than kept here; `scripts/resolve-python.sh`
uses the host interpreter when it satisfies that, and only provisions the
discovered minimum through mise as a fallback. See
[Emscripten SDK resolution](#emscripten-sdk-resolution).

Node.js is intentionally **not** a project-managed tool. Emscripten supplies
its own Node for its internal JavaScript tooling. Real Wrangler deployment and
Vite dev/preview may use a host-provided Node; none of the project-owned build,
validation, test or dry-run paths install or require one.

`package.json` declares no Node runtime requirement: no project workflow is
executed by Node, so there is no `engines.node` and no Node dependency.
CMake is pinned to `4.4.5` because the Emscripten 6.0.13
toolchain warns for CMake `4.2.0`–`4.3.3`, while
[wasm/CMakeLists.txt](wasm/CMakeLists.txt) requires at least CMake `4.2`.

### Provision the toolchain dependency domain

There is no root `node_modules` and no root lockfile: the application owns no
dependencies. Vite, Wrangler, TypeScript and the Cloudflare Vite plugin, with
their complete transitive tree, live in a separate, externally installed domain.

```bash
mise exec -- deno task toolchain:specify -- --deno <version> --vite <version> \
  --wrangler <version> --emscripten <version>
mise install
mise exec -- deno task toolchain:install
```

The first writes the toolchain specification — `.mise.toml` and
`toolchain/package.json` — from the versions you supply on the command line,
and installs nothing. `mise install` then establishes that installation once
(CI does the same through `jdx/mise-action`), and this project never rewrites,
relocates or copies the installed tools. The second command materialises the
toolchain's own
[toolchain/deno.lock](toolchain/deno.lock) into the generator-owned subtree
`generator/dependencies/` beneath this project root (override the tree with
`GENERATOR_ROOT`, or name the owning project root with
`GENERATOR_PROJECT_ROOT`), staged in a sibling directory inside the same
subtree and then swapped into place, and writes `toolchain.json` last as its
readiness record. Anything that resolves outside `generator/` is rejected
before the installation touches the filesystem. `--frozen` inside that install means a lock that disagrees with the
manifests fails instead of resolving; the first provision needs registry access,
afterwards the artefacts are cached.

Ordinary builds, typechecks, development, preview and deployment never install,
resolve or update anything; they consume the installed toolchain and fail with an
explicit message if it is absent or incomplete.

Deno may report that npm lifecycle scripts were ignored, notably for
`workerd`. On the supported Ubuntu platforms the pinned platform-specific
package supplies the workerd binary used by Wrangler, so this notice does not
prevent builds, tests or dry runs.

After the toolchain and dependencies are installed, the build, tests and
Wrangler dry run do not require network access. Wrangler's update check is
best-effort and time-bounded, so an offline dry run still succeeds.

### Verify the toolchain

```bash
mise exec -- deno --version     # deno 2.9.8
mise exec -- cmake --version    # cmake version 4.4.5
mise exec -- ninja --version    # 1.13.2
mise exec -- emcc --version     # ... 6.0.13 (...)

scripts/resolve-python.sh       # path, version and source of the emcc interpreter
```

`mise exec --` runs a command with the pinned tools on `PATH`. Project-owned
Deno tasks, the development and preview servers and deployment all use the pinned
Deno. No host Node is used or required; Emscripten’s own embedded Node remains
internal to its toolchain.

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
detects a toolchain change and triggers a clean reconfigure. The build does not
use a project Node; Emscripten uses its own embedded Node as an encapsulated
toolchain detail.

Emscripten's `emcc`/`em++` drivers are Python programs, and the pinned emsdk
does not bundle an interpreter. Emscripten owns that requirement — its
`emcc.py` asserts Python >= 3.10 — and the project treats Python as a host
prerequisite rather than a pinned tool.

`scripts/resolve-python.sh` implements one resolution policy, used by the build
and by CI:

| Order | Source | Behaviour |
| --- | --- | --- |
| 1 | `EMSDK_PYTHON` | Used when set. A missing, non-executable or too-old value is a hard error, so an explicit request is never silently replaced. |
| 2 | host `python3` | Used when it satisfies the SDK's requirement. The optional `python` name is not consulted. |
| 3 | mise fallback | `mise install python@<discovered requirement>`, then `mise which --tool "python@<requirement>" python3`. Only reached when 1 and 2 cannot supply a usable interpreter. |

The resolver prints the absolute path, the version and how it was obtained; the
build exports `EMSDK_PYTHON` from that value before invoking Emscripten and
re-asserts it after `emsdk_env.sh` runs, so `emcc`, CMake and Ninja all use the
same interpreter. Stage `[1/9]` shows the result, for example
`python 3.14.4 (/usr/bin/python3.14, host python3)`.

The host interpreter does not have to match the fallback version: any interpreter
satisfying the SDK is accepted, and only a host without one causes a mise install
of the discovered minimum.

### Environment variables used by the tooling

| Variable | Used by | Purpose |
| --- | --- | --- |
| `EMSDK_ROOT` | `scripts/build.sh` | Explicit Emscripten SDK root override |
| `EMSDK` | `scripts/build.sh` | SDK root normally exported by mise |
| `EMSCRIPTEN_ROOT` | `scripts/build.sh` | Fallback when the expected SDK layout is absent |
| `EMSDK_PYTHON` | `scripts/resolve-python.sh`, Emscripten `emcc` | Python interpreter for `emcc`. An explicit value is validated (exists, executable, >= 3.10) and never silently replaced; the build exports the resolved value |
| `CLOUDFLARE_API_TOKEN` | Wrangler | Non-interactive Cloudflare authentication |
| `TMPDIR` / `RUNNER_TEMP` | `scripts/ci.sh` | Parent directory for the temporary build copy |
| `MISE_YES`, `DENO_NO_UPDATE_CHECK` | GitHub Actions workflow | Non-interactive tool install and quieter Deno output |

The repository does not contain or require a credentials file.

## Initialise the project

The template stores its identity as a placeholder. Until initialisation the
configured Cloudflare Worker name is not a valid Worker name, so the Vite
Cloudflare plugin and Wrangler reject it: `deno task dev`, `deno task build`,
`deno task check:worker-types` and `deno task deploy` fail on an untouched
template. Initialise once, before any of those commands.

### Commands and options

```bash
# preview every change; writes nothing
mise exec -- deno task init:project my-app --dry-run

# apply
mise exec -- deno task init:project my-app

# placeholder, target files, name rules and exit codes
mise exec -- deno task init:project --help
```

Equivalent task-runner form:

```bash
mise exec -- deno task init:project my-app --dry-run
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
| `scripts/vite-build.mjs` | Deno-owned Vite launcher, invoked by `scripts/build.sh`; resolves the installed CLI and both native bindings, then runs Vite under an explicitly selected permission profile (`local` by default, `ci-runner` in CI) |
| `scripts/wrangler-types.mjs` | Deno-owned Wrangler type-generation launcher, invoked by `scripts/worker-types.sh`; resolves Wrangler, workerd and esbuild, then runs only `types` under an explicit permission profile |
| `scripts/wrangler-dry-run.mjs` | Deno-owned Wrangler dry-run launcher, invoked by `scripts/deploy-dry-run.sh`; resolves Wrangler and esbuild, then runs only `deploy --dry-run` under a separate scoped profile |
| `scripts/deno-no-node.sh` | PATH tripwire for project-owned execution; rejects command-name `node`/`nodejs` attempts |
| `scripts/resolve-python.sh` | Resolves the `emcc` interpreter: `EMSDK_PYTHON`, then a host `python3` that satisfies the SDK requirement, then a mise-provisioned fallback at that same requirement |
| `scripts/deploy-dry-run.sh` | Builds, validates artefacts and invokes the Deno dry-run launcher; never deploys |
| `scripts/contract-refresh.sh` | Contract refresh entry point (generator only): derives the lock from the authorised configuration and the installed toolchain via the authoring CLI; `--print-workerd` prints the resolved runtime path without probing |
| `scripts/contracts/` | Contract model: scopes and fingerprints, schema and conformance, verification, product CLI (`cli.mjs`), plus generator-only derivation, probing and authoring |
| `.mise.toml`, `deno.json`, `package.json`, `deno.lock` | The mise configuration specification and task definitions; the locked dependency graph lives in `toolchain/` |
| `scripts/toolchain-specify.mjs` | Writes the toolchain specification from the versions supplied on the command line; it installs nothing |
| `toolchain-contracts.json` | The committed contract lock: derived facts a product inherits; verification accepts only a conformant lock |
| `worker-configuration.d.ts` | Generated, tracked Worker `Env` types; never edit by hand |

### Development server

```bash
mise exec -- deno task dev
# choose another port:
VITE_DEV_PORT=5199 mise exec -- deno task dev
```

This starts Vite under Deno, with the toolchain-owned Cloudflare plugin and a
local Worker runtime (`workerd`, spawned by the toolchain). It needs an
initialised project but no Cloudflare account or credentials. Worker code and
client code are served from source; nothing is deployed. The listener is
loopback-only; see “Development and preview permissions”.

### Development and preview permissions

`deno task dev` and `deno task preview` run in a separate Deno process with the
narrowest profile each mode needs, derived in `scripts/vite-server.mjs` and
recorded as contract facts (`launcher.vite-dev`, `launcher.vite-preview`):

| Grant | Why |
| --- | --- |
| read | application configuration, the toolchain tree, the runner |
| write (application root) | Vite cache (`.vite/`), Worker state, Wrangler logs |
| env, sys | Vite, Rolldown and Wrangler requirements |
| run (real `workerd`) | the Cloudflare plugin runs the Worker in it |
| ffi (real Rolldown, LightningCSS) | Node-API bindings |
| net `127.0.0.1,localhost,0.0.0.0:<port>,[::]:<port>` | see the exception below |

`TMPDIR`, `XDG_CONFIG_HOME` and `WRANGLER_LOG_PATH` are redirected into the
application's ignored `.wrangler/` tree, so no profile writes under the home
directory and no permission is widened to silence a warning.

**Wildcard-bind exception.** Vite 8 probes port availability by binding every
wildcard host on the configured port before it binds its listener
(`isPortAvailable` in `vite/dist/node`). Under Deno that probe is a permission
requirement, so the profile grants it for that one port only. It is not a
requirement for the long-lived listener: the server binds `127.0.0.1:<port>`,
which `ss -ltnp` confirms. `esbuild` process permission is deliberately absent —
development and preview do not need it.

### Full build

```bash
mise exec -- deno task build
```

`scripts/build.sh` performs nine printed stages:

1. Resolve and initialise the Emscripten SDK, resolve the Python interpreter for
   `emcc` (host first, mise fallback only if needed), and verify `em++`, `cmake`,
   `ninja` and the installed npm dependency tree (`tsc`, `vite`, `wrangler`) are
   available. No project Node is required.
2. Configure CMake with the Emscripten toolchain.
3. Build the C++ sources with Ninja.
4. Publish the build-tree `wasm_math.js` and `wasm_math.wasm` to
   `public/wasm/`.
5. Type-check the client with the TypeScript 7 checker (launched by Deno).
6. Type-check the Worker with the same checker.
7. Check that `worker-configuration.d.ts` is current through the Deno-owned
   Wrangler types launcher.
8. Remove `dist/` and run the Deno-owned Vite production build for the Worker and
   client.
9. Run the published-artefact WASM smoke test.

The build fails early with an explicit message if the npm dependencies are
missing (provision it with `mise exec -- deno task toolchain:install`), if the
Emscripten SDK cannot be
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

#### JavaScript language level, runtime capabilities and browser target

Type-checking, production bundling and runtime capability are three different
questions, and the project answers each with evidence rather than assumption.
The answers live in [`toolchain-contracts.json`](toolchain-contracts.json), the
committed **contract lock**. The lock is *derived*, not decided: `deno task
contract:refresh` records what the authorised configuration and the installed
toolchain imply, and CI recomputes the same facts and only verifies them.

- **Language level (authoring).** Both `tsconfig.json` files set
  `target: "ESNext"`, so authors are not capped below what the installed
  compiler parses. Neither project emits JavaScript.
- **Worker `lib`.** `ES2025` is anchored to measured workerd capability, not to
  the compiler's newest edition and not to an assumption that workerd is newer
  than a browser. The `workerd-runtime` contract records which ES editions the
  installed runtime actually supports, probed with this project's compatibility
  date and flags, and `deno task check:contracts` fails if the declaration
  drifts from that measurement.
- **Client `lib`.** `ES2023` is an *authoritative* declaration in
  `tsconfig.json`, recorded in the lock together with the compiler's shipped
  editions; `check:contracts` fails if the declaration names an edition the
  installed TypeScript does not provide. No installed tool carries a
  browser-API database, so the correspondence between an ES edition and Vite's
  resolved browsers stays a documented limitation rather than a mechanical
  check — which is why the Vite target is recorded alongside it.
- **Production browser target.** Vite owns the mapping from its default
  `baseline-widely-available` to concrete browsers, and that mapping changes
  between releases. `vite.config.ts` may override `build.target`; the reader
  accepts exactly one string or string-array literal and fails closed on
  anything else. The lock records both the configured target and the resolved
  browser list.
- **Development server.** Its transform policy is separate from the production
  browser target and is not affected by any of this.

No Babel, legacy-browser plugin or polyfill is used: the target is a maintained
Baseline, not a legacy matrix.

#### Toolchain contracts: derive, record, verify

The lock is a record of facts, not an approval. Nothing in it is a human
decision, so there is nothing in it for a human to certify; what a human
authorises is the **source configuration** the facts are derived from.

1. **Authorise the design in source.** `wrangler.jsonc` (compatibility date and
   flags), both `tsconfig.json` files (`lib`), `vite.config.ts` (`build.target`),
   the pinned dependency set (`package.json`, `deno.lock`) and the launcher
   argument builders are the specification. Changing any of them changes what
   the lock must say.
2. **Record the facts explicitly.** `deno task contract:refresh` resolves the
   toolchain from the project's own dependency graph (Wrangler → Miniflare →
   workerd, cross-checked against the Vite plugin), reads the configuration,
   asks the installed Vite and TypeScript what they provide, and runs a
   capability probe inside the real `workerd` binary. It writes
   `toolchain-contracts.json` and nothing else. It is the **only** writer, it
   never runs in CI, and its output is deterministic: no timestamps, run
   identifiers, host paths or approval metadata, so a second run on the same
   authorised configuration is byte-identical.

   Canonical refresh happens on the **authorised platform** (`ubuntu-24.04`,
   `linux-x86_64-gnu`) with the pinned mise toolchain **and the Emscripten SDK
   available**: the lock records how the WASM artefact is produced, so refresh
   refuses to run when `EMSDK` is unset rather than recording degraded
   provenance. Run it as `mise exec -- deno task contract:refresh`.
3. **Review the change, not the facts.** The lock lives in version control, so a
   source change that moves a contract shows up as a lock diff in the same pull
   request. The reviewer authorises the change; the machine derives the values.
4. **Verify in CI.** `deno task check:contracts` recomputes the facts, compares
   them with the committed lock, reports one status per scope, and fails on
   `drifted` or `unrecorded`. It never starts workerd or Vite: its permission
   profile is `--allow-read` and `--allow-env`, which is itself the evidence
   that it cannot derive or rewrite anything.

Drift is a failure to investigate, never an automatic refresh: a run that could
repair its own contract could never fail.

A scope is reported as one of three statuses:

| Status | Meaning | CI |
| --- | --- | --- |
| `recorded` | The current derivation matches the committed lock | accepted |
| `drifted` | A contract exists for the scope but describes different facts | rejected |
| `unrecorded` | The lock has no contract for that scope | rejected |

Each verification run prints a machine-readable conformance report on stdout
(schema version, verdict, per-scope status, current and recorded fingerprints,
changed inputs and the lock digest) and human diagnostics on stderr. The report
is produced even when the verdict is a failure, and it distinguishes a missing
contract from a changed one.

The lock is a dictionary of contracts keyed by scope and fingerprint
(`workerd-runtime@sha256:…`, `vite-syntax-target@sha256:…`,
`typescript-libraries@sha256:…`, `launcher-permissions@sha256:…`). Each
fingerprint covers only the inputs that can change that contract: the runtime
contract covers workerd, the compatibility date, the flags and the platform, but
not Vite or TypeScript, so unrelated upgrades do not force a refresh.

Every value records what kind of statement it is:

| Provenance | Meaning |
| --- | --- |
| `authoritative` | Read from the project's own configuration or installed package manifests |
| `observed` | Measured by a probe in the authoring environment |
| `derived` | Computed from other values by a rule stated in its evidence |
| `unverified` | Evidence is missing or a probe failed; conformance cannot be established |

There is no `declared` provenance: a value no derivation supports does not belong
in a lock. Human decisions live in the source the lock is derived from.

The recorded Deno version is enforced, not merely recorded: verification compares
the lock's `toolchain.deno.version` with the interpreter that is running, so
adopting a different Deno fails until the authorised toolchain is installed or
the lock is refreshed and the change reviewed. Deno is deliberately not a scope:
it determines no compatibility fact, so it stays provenance plus an explicit
conformance check rather than a fingerprint.

#### Generator repository and generated product

This repository is the **generator** (the manufacturing system). A generated
project is the **product**, created by a separate copy operation:

```bash
deno task product:generate my-app --into ../my-app
```

The operation copies the positive allowlist in
[`scripts/product-manifest.mjs`](scripts/product-manifest.mjs) into a fresh
destination, rewrites the product's task list so it references only files it
received, and substitutes the project identity **in the destination only**. The
generator tree is never modified.

- **Included:** application source and assets, runtime/build configuration,
  `deno.lock`, `.mise.toml`, project CI workflow, the inherited
  `toolchain-contracts.json` (the lock a product inherits as-is — a product
  verifies it and CI accepts only a conformant lock), build/deploy/smoke
  tooling, and the *verifier*
  (`scripts/contracts/{scopes,schema,config,store,toolchain,permissions,verify,
  canonical,cli}.mjs`, `scripts/check-contracts.sh`), plus product-side contract
  tests.
- **Excluded:** derivation and probing (`discover.mjs`, `fixtures.mjs`,
  `workerd-probe.mjs`, `lib/toolchain/vite*.mjs`), authoring (`author-cli.mjs`,
  `contract-refresh.sh`), toolchain
  management (`toolchain-specify.mjs`, its suite and the
  `toolchain:specify` / `test:toolchain-specify` tasks), the
  generator regression suite (`generate-product.test.mjs`, `test:generator`),
  and the initialiser. Because the list is positive,
  a new generator file does not enter a product until someone adds it and
  justifies it; `assertManifestDisjoint()` and
  `assertProductBoundary()` fail closed on a mistake.

An existing non-empty destination is refused (exit 2); generation never
overwrites an unrelated project.

**A product verifies; it never refreshes.** The product ships `verify`, `status`
and `show`, and has no command that can derive, refresh or rewrite its lock.
Changing a product's contract means changing the generator template and
delivering the resulting lock through the reviewed update path — the product
cannot manufacture its own record.

#### Component identity, scoped fingerprints and build provenance

[`scripts/contracts/scopes.mjs`](scripts/contracts/scopes.mjs) is the single
source of truth. Each component declares the scopes for which its identity is
key evidence (`keyFor`) and the fingerprint fields it contributes;
`fingerprintInputs` is **derived** from those declarations, never maintained
separately.

| Component | Key for | Recorded as provenance |
| --- | --- | --- |
| platform | all three runtime contracts | — |
| workerd | `workerd-runtime` (version, compatibility date/flags) | — |
| vite | `vite-syntax-target` | — |
| typescript | `typescript-libraries` | — |
| emscripten | nothing today | SDK version, Emscripten version, installation layout, standard-library marker |

Emscripten is therefore **provenance-only** for the three runtime contracts: an
Emscripten upgrade does not invalidate them and does not require template
regeneration. It would become key only for a C++ compiler-capability contract,
which does not exist yet; no such contract is implemented or implied here. Fields
that cannot be established without executing the SDK compiler (clang version,
exact LLVM revision, target triple) are recorded as unavailable with an explicit
reason — the LLVM revision is never inferred from a version number.

Compatibility fingerprints and build provenance are different claims. An
unchanged runtime fingerprint is not evidence of a reproducible build, and a
changed compiler does not by itself mean a runtime contract broke;
`buildProvenanceDigest()` exists to make compiler changes visible without
implying either.

The committed lock describes this repository as it stands, so CI verifies rather
than approves: a source change that moves a contract fails conformance until
`deno task contract:refresh` records the new facts and the resulting lock diff is
reviewed with the change that caused it.

#### Toolchain version selection

The toolchain versions are supplied **explicitly on each invocation**, as
arguments to one task:

```bash
mise exec -- deno task toolchain:specify -- --deno 2.9.8 --vite 8.3.5 \
  --wrangler 4.156.0 --emscripten 6.0.13
```

- The four versions are the **only** version authority. Nothing is read from
  shell profiles, environment variables, a previous installation, or an implicit
  `latest`; ranges and tags are refused, and an invocation that omits any of the
  four tools fails.
- The task **writes the specification** — [`.mise.toml`](.mise.toml) for the
  mise-installed tools and [`toolchain/package.json`](toolchain/package.json)
  for the locked packages — and installs nothing. Writing the specification is
  not the same as writing into an installed toolchain, which this project never
  does.
- CMake and Ninja are build prerequisites the generator pins itself; they are
  not part of the specified surface. Node and Python stay host-provided.
- `scripts/toolchain-specify.mjs`, its suite and the `toolchain:specify` /
  `test:toolchain-specify` tasks are **generator-only**: a generated product
  inherits the `.mise.toml` it was built with and has no command that resolves or
  re-pins a toolchain.

`mise install` establishes the specified installation **once** — the operator
runs it, and CI's `jdx/mise-action` does the same from the same file. The
resulting installation is an invariant of the project: the generator inspects,
qualifies and executes those tools, and no command in this repository installs,
upgrades, stages, relocates or copies them afterwards. Tests never install
anything; they assert against the established installation or use the plan
output of the dependency installer.

`deno task toolchain:install` materialises the locked *packages*
([`toolchain/deno.lock`](toolchain/deno.lock)) into the generator-owned subtree
`generator/dependencies/`; it invokes no tool installation at all, which the
invariant suite asserts with a `mise` stub on `PATH`.



Probe outcomes are three-valued — `supported`, `unsupported`, `probe-failed` —
and a failed probe is never recorded as an unsupported capability. A capability
probe that cannot start the runtime leaves the value `unverified`, which blocks
approval and therefore blocks CI.

Policies are derived facts now, not declarations. The client API edition is read
from `tsconfig.json` and checked against the compiler's shipped editions; the
launcher permission profiles are derived from each launcher's own argument
builder, and both named Vite profiles — `vite-build` for `local` and
`vite-build-ci-runner` for the CI-only grant — are recorded in the
`launcher-permissions` contract. Widening a profile therefore changes a
fingerprint, which fails conformance until the lock is refreshed and the change
reviewed. Nothing here is approved separately: the review happens on the source
change that caused it.

#### Worker type generation

`worker-configuration.d.ts` contains the generated `Env` interface and runtime
types. After changing bindings or `wrangler.jsonc`, regenerate it and review
the diff:

```bash
mise exec -- deno task types:worker
mise exec -- deno task check:worker-types   # freshness check used by the build
```

The file is tracked, excluded from formatting and linting, and must not be
edited by hand. Both commands require an initialised project. They run through
`scripts/wrangler-types.mjs` in a separate Deno process with read/write/env/sys,
loopback-only `--allow-net=127.0.0.1`, and `--allow-run` scoped to the installed
workerd and esbuild executables. esbuild is required even for plain generation:
Wrangler uses it to resolve the Worker main module, and omitting it silently
drops `Cloudflare.GlobalProps.mainModule`. No Node, broad net, FFI or
all-permissions access is granted to type generation.

Wrangler dry-run has its own, separate profile in
`scripts/wrangler-dry-run.mjs`. It grants read/env/sys, write access only to
`dist/worker` and Wrangler's config log directory, and run access only to the
installed esbuild executable. Dry-run needs neither workerd nor FFI nor network
access; it also does not use the npm Wrangler wrapper. The launcher runs without
Node on `PATH`. The dry-run wrapper still invokes `deno task build` and
`deno task check:deploy` first, preserving the existing build/check/dry-run flow.

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
| `deno task check:node-boundary` | Configuration invariants: no `@types/node`, no Node tsconfig types or lib, no `nodejs_compat*` flag | Deno |
| `deno task test:init` | Initialiser unit tests in temporary fixtures | Deno |
| `deno task test:worker` | Worker handler tests, invoked directly | Deno |
| `deno task test:scripts` | Emscripten SDK-root resolution tests with fake layouts | Deno and Bash |
| `deno task test:deploy` | Deployment-artefact checker unit tests in temporary fixtures | Deno |
| `deno task test:boundary` | Configuration invariants, including negative canaries and Worker typecheck coverage | Deno |
| `deno task test:vite` | Vite CLI/native-binding resolution, both named permission profiles and the Bash wiring that selects one | Deno |
| `deno task test:wrangler-types` | Wrangler CLI/workerd/esbuild resolution and the explicit type-generation permission profile | Deno |
| `deno task test:wrangler-dry-run` | Direct Wrangler CLI/esbuild resolution, dry-run profile, argument forwarding and exit propagation | Deno |
| `deno task test:toolchain` | Installed-package and TypeScript library discovery primitives, including version-pinned resolution | Deno |
| `deno task test:toolchain-specify` | Explicit toolchain specification: argument validation, environment independence, written specification, and the installation/immutability invariants (generator only) | Deno |
| `deno task test:contracts` | Contract conformance: canonical fingerprints, refresh determinism, drift detection, permission-profile derivation and verification helpers | Deno |
| `deno task test:generator` | Generator/product boundary: allowlist copying, task rewrite, determinism, generator-only toolchain exclusion and the product's own validation/contract verification (generator only) | Dependencies; generator repository only |
| `deno task test:no-node` | Node-exclusion tripwire: rejection, exit/argument propagation, legitimate tools, parent isolation and Node-absent operation | Deno |
| `deno task check:contracts` | Conformance gate: recomputes the contract facts, compares them with the committed lock, reports one status per scope and prints the machine-readable report. Drift or a missing scope fails. No derivation, no writes | Dependencies |
| `deno task status:contracts` | Prints one line per scope (`recorded`, `drifted`, `unrecorded`); exits non-zero unless every scope is recorded | Dependencies |
| `deno task contract:refresh` | Derives every contract fact — including a real workerd capability probe — and writes `toolchain-contracts.json`. Requires the authorised platform (`ubuntu-24.04`) and the pinned toolchain with `EMSDK` available; it refuses to run without the SDK. `scripts/contract-refresh.sh --print-workerd` reports the resolved runtime without probing | Dependencies, workerd, Emscripten SDK |
| `deno task check:worker-types` | `worker-configuration.d.ts` is current | Initialised project, dependencies |
| `deno task types:worker` | Regenerates `worker-configuration.d.ts` (writes) | Initialised project, dependencies |
| `deno task test:wasm` | Build-tree WASM smoke test on Deno, Node globals hidden (`19 + 23 = 42`) | Build required |
| `deno task test:wasm:published` | Published (`dist/client`) WASM smoke test on Deno (`19 + 23 = 42`) | Full build required |
| `deno task check:deploy` | Generated config/artefact consistency, symlink containment and the Node boundary in the emitted bundles | Full build required |
| `deno task deploy:dry-run` | Build, artefact check and Deno-owned `wrangler deploy --dry-run` | Initialised project, dependencies |
| `deno task validate` | `fmt:check`, `lint`, client/Worker typechecks, the Node boundary check and every Deno test suite, then contract enforcement (the acceptance gate, last) | Dependencies; works on the template |
| `deno task ci` | `scripts/ci.sh all` (static checks plus isolated build validation) | Dependencies; works on the template |

Deno tasks are canonical and are the only task surface. There are no npm script
equivalents: starting a workflow through `npm run` would execute Node to launch
it, which the Node-exclusion contract forbids. `package.json` remains as package
metadata (name, type, dependencies) for the tools that read it.

The `validate` chain is the same shape in both trees: a generated product
rewrites it to the tasks it actually received, and it also keeps
`check:contracts` **last**, after every independent check and test suite. A
drifted or unrecorded contract therefore never hides the product's own suites;
the gate still fails the chain at the end.

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
| `static` | Formatting, linting, client and Worker typechecks, the Node dependency-boundary check and tests, Worker runtime tests, contract conformance tests, the generator-only suites where present, Vite/Wrangler/Node-exclusion tests, then the strict contract gate last |
| `build` | Build/deployment tooling tests, dependency check, throwaway build copy, throwaway identity (generator repository only; a generated product is already initialised and ships no initialiser), Worker types freshness, full build, deployment-artefact check, both Deno WASM smoke tests, Deno-owned Wrangler dry run, then the strict contract gate last |
| `all` | `static` followed by `build` (the default). `static` ends at the conformance gate; if the environment has drifted, run `deno task contract:refresh` on the authorised platform and review the lock diff first |

The checkout is never modified. The build mode copies the working tree
(including uncommitted changes) to a temporary directory, leaving out Git
metadata, dependencies and generated output (`.git`, `node_modules`, `dist`,
`build-wasm`, `.wrangler`, `public/wasm`), symlinks the existing `node_modules`,
and removes the copy on exit. It initialises the copy as `ci-smoke`; if the
source is already initialised that step is a no-op, so the copy keeps the
existing identity.

The `static` mode does not include `test:scripts` or `test:deploy`; those run
at the start of the `build` mode. `deno task validate` does include both.
`scripts/ci.sh build` needs the installed toolchain; the explicit check inside
it prints the provisioning command if the installation is missing. Provision it
with `mise exec -- deno task toolchain:install` before either mode that performs
typechecks or builds. Neither mode installs or resolves anything.

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

`deploy:dry-run` requires no Cloudflare credentials and runs through the
Deno-owned `scripts/deploy-dry-run.sh` / `scripts/wrangler-dry-run.mjs` path.
`check:deploy` requires a completed build.

### What the dry-run and deployment commands do

`scripts/deploy-dry-run.sh`:

1. Runs `deno task build`.
2. Confirms that the generated configuration
   `dist/worker/wrangler.json` exists.
3. Runs `deno task check:deploy` against the generated artefacts.
4. Runs the Deno-owned Wrangler dry-run launcher with that configuration and
   `--dry-run`.

`scripts/deploy.sh` — the real deployment path — is unchanged:

1. Runs `deno task build`.
2. Confirms that the generated configuration exists.
3. Runs `deno task check:deploy`.
4. Runs Wrangler’s `deploy` under Deno with that generated configuration
   (`scripts/wrangler-deploy.mjs`: read/env/sys, write to `.wrangler`, the real
   `esbuild`, and `api.cloudflare.com` only).

Extra arguments are passed through to Wrangler by both paths. The dry-run
launcher adds `--dry-run` itself; it does not use the npm Wrangler wrapper.

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

## Deployed-edge acceptance

Build validation proves the application *can* be built; toolchain conformance
proves the authorised environment matches the recorded contract. Neither says
anything about the deployed application. **Deployed-edge acceptance** closes that
gap: the application is deployed to a disposable Cloudflare Worker, loaded in a
real browser, and accepted only when the rendered page and the WebAssembly result
match the authorised criteria.

```
build validation ──► toolchain conformance ──► deployment ──► edge acceptance
      (can build)        (authorised env)     (command ok)   (behaves correctly)
```

Each layer keeps its own verdict: a successful build or deployment never
substitutes for a failed edge assertion.

- **Criteria** live in [`acceptance/criteria.json`](acceptance/criteria.json):
  the page marker, the exact WebAssembly result string
  (`WebAssembly result: 19 + 23 = 42`), the Worker health text, the loading
  placeholders that mean "not finished yet", and the failure markers that must
  not appear. Editing that file changes what "accepted" means.
- **The URL comes from the deployment**, never from a template. Wrangler does not
  print a workers.dev URL, so the account's own subdomain is read from the
  Cloudflare API and paired with the deployed Worker name the deployment
  reported; a URL found in the deploy log wins, and the evidence records which
  source was used.
- **Readiness is waited for, not assumed.** Wrangler reports success when the
  version is uploaded, but the workers.dev route serves it slightly later: until
  it does, Cloudflare answers with its own error page (error 1042) or a transient
  5xx. [`scripts/edge-readiness.sh`](scripts/edge-readiness.sh) therefore polls
  the published URL every two seconds for up to thirty, records every attempt
  (number, elapsed time, HTTP status, Cloudflare error code, diagnostic), and
  proceeds only on HTTP 200 **that is the application this run deployed** — the
  body must contain the `#app` mount point from `index.html` and its `<title>`
  must be the Worker name, so an arbitrary 200 (a Cloudflare welcome page,
  another deployment's page) cannot be mistaken for readiness. On timeout the
  final response and the full history are printed and the run fails.
- **The browser is real**: the preinstalled Chrome on the runner, driven over the
  loopback DevTools protocol by [`scripts/edge-verify.mjs`](scripts/edge-verify.mjs).
  No Playwright, no container, no additional dependency. The observer waits —
  bounded by `--timeout` — until the marker, `#wasm-result`, the Worker health
  text and the build-identity meta element are all present *and* no longer show
  a loading placeholder. An absent element keeps the wait going: absence is not
  readiness. The navigation's own document response is inspected too, so a 404
  the browser received is a rejection rather than an unremarkable success.
- **Identity binding**: the page title is baked in at build time from the
  initialised project name, so `page.identity` proves the tested page belongs to
  *that* deployment rather than to another Worker.

Run it with:

```bash
gh workflow run edge-acceptance.yml -f confirm=accept
```

The workflow is `workflow_dispatch`-only (it deploys), never production, and uses
a throwaway Worker named `edge-<run_id>-<attempt>` that is deleted at the end.
Evidence is uploaded as the `edge-acceptance-<run_id>-<attempt>` artefact, after
cleanup, so it contains the cleanup outcome:

| File | Contents |
| --- | --- |
| `acceptance.json` | source SHA, deployment URL and its source, deployment id, HTTP status, browser, navigation status, browser readiness outcome, per-assertion results, overall `accepted`, the edge readiness history (`edgeReadiness`) and the cleanup record (`cleanup`) |
| `edge-readiness.json` | the readiness attempt history on its own: every attempt's elapsed time, HTTP status, Cloudflare error code and diagnostic |
| `screenshot.png` | supplementary evidence only — never the decision |
| `page.html` | the last response body the readiness gate tested |
| `cleanup.json` | the teardown record: the Worker name, whether deletion and verification were attempted, their HTTP results, per-attempt diagnostics, the final classification and a timestamp |
| `deploy.log` | the deployment command's output |

### Teardown is verified, not assumed

`scripts/edge-cleanup.sh` deletes the disposable Worker and then proves it is
gone. It deliberately does **not** use `wrangler delete`: Wrangler 4.156 deletes
the Worker and *then* runs a legacy Workers Sites post-check that lists KV
namespaces. Under a Workers Scripts:Edit token that call returns Cloudflare error
`10000` (401), and Wrangler tolerates only a `403` there, so it exits non-zero
**after a deletion that already succeeded** — which is how two runs reported
"cleanup could not delete … delete it manually" for Workers that were, in fact,
already gone.

The script uses the two documented, name-scoped endpoints and nothing else:

| Step | Request | Meaning |
| --- | --- | --- |
| deletion | `DELETE /accounts/{account_id}/workers/scripts/{script_name}?force=true` (`worker-script-delete-worker`) | the request; its `200` is never the verdict |
| verification | `GET /accounts/{account_id}/workers/scripts/{script_name}/settings` (`worker-script-get-settings`) | `404` (code `10007`) means absent; `200` means the Worker still exists |

`/workers/services/{name}`, which Wrangler deletes through, is not part of
Cloudflare's public API schema, so the two are not interchangeable and the
documented `workers/scripts` resource is the one used here. No KV endpoint is
called, so the token keeps its existing Workers Scripts:Edit scope.

The verification is authoritative: confirmed absence is a success (including when
the Worker was already absent), and a Worker that is still readable is a failure
even when the deletion answered `200`. Transient failures (`5xx`, `429`, no
response) are retried within a small bound; authentication and permission errors
are never retried. The script rejects anything that is not a disposable
`edge-<digits>-<digits>` identity *before* constructing a request, never lists or
enumerates Workers, and reads the token from `CLOUDFLARE_API_TOKEN` only — passing
it to `curl` through a private `--config` file so it never appears in the argument
vector — and scrubs the credential from every string it writes.

Its exit status (`0` verified absent, `1` cleanup failed, `2` refused) is the
cleanup verdict. The workflow records it in the `cleanup` step outcome, in
`cleanup_exit` / `cleanup_classification` step outputs, in the job summary and in
`cleanup.json`; because cleanup runs with `continue-on-error`, a cleanup problem
stays visible without changing the application's acceptance verdict.

Concurrent runs are independent by construction rather than by luck: the Worker
name is derived from the run id and attempt, each run works in its own
`${{ github.workspace }}/.acceptance` tree, the artefact name is run-scoped and
cleanup deletes `"$WORKER_NAME"` and nothing else. `scripts/edge-readiness.test.mjs`
reads those identities out of the workflow and checks them. The `concurrency`
group is per ref with `cancel-in-progress: false`, so a second dispatch on the
same ref is queued rather than cancelled mid-teardown — a scheduling choice, not
the isolation mechanism.

Prerequisites (none of which are configured in this repository yet, so the job
fails closed with this list rather than passing silently):

- repository **secret** `CLOUDFLARE_API_TOKEN` — Workers Scripts:Edit on an
  account you are willing to deploy disposable Workers into;
- repository **variable** `CLOUDFLARE_ACCOUNT_ID`;
- workers.dev enabled for that account (the acceptance URL is a `*.workers.dev`
  address).


## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pushes to
`main` and pull requests targeting `main`. It uses `ubuntu-24.04` with a
30-minute timeout, read-only `contents` permission and concurrency that
cancels an older run for the same branch.

The workflow runs on two jobs:

- **Validate (static).** Checks out the repository without persisting
  credentials, installs the pinned toolchain with `jdx/mise-action` (caching
  mise's install and download directories, including the Emscripten SDK, under a
  key derived from `.mise.toml`; the post-step save also captures Emscripten's
  compiler cache), verifies the pinned Deno/CMake/Ninja/Emscripten versions,
  runs `scripts/resolve-python.sh` for the same interpreter the build will use,
  and provisions the toolchain dependency domain with
  `deno task toolchain:install -- --allow-download` into the checkout's own
  `generator/dependencies` subtree (`GENERATOR_PROJECT_ROOT` names the owning
  project root, which is how a temporary copy reuses the generator's tree). It then runs formatting, linting,
  both typechecks, the Node dependency-boundary check and tests, Worker runtime
  tests, toolchain discovery and contract conformance tests, the guarded
  generator-only suites (`test:toolchain-specify`, `test:generator`,
  `test:provenance`), and the
  Vite, Wrangler, Node-exclusion, provenance-reader, output-boundary and
  CI-workflow suites. The strict contract gate is the
  **last** step of this job, so a rejected contract cannot hide any of them.
- **Build validation.** Runs `needs: validate` with `if: !cancelled()`: the
  dependency only orders the jobs, so this job runs whether the static job passed
  or failed. The workflow as a whole still fails when either job fails, and the
  gate is never downgraded. It installs the same pinned toolchain and
  dependencies (each job has its own runner, so the cache is restored twice under
  the same keys) and runs `scripts/ci.sh build` in a throwaway initialised copy:
  tooling tests, Worker types freshness, full build, deployment-artefact check,
  both Deno WASM smoke tests, the Wrangler dry run, and the contract gate again —
  last, so the generated configuration is compared with build output present.
  Emscripten's interpreter is resolved inside the build, so no separate
  diagnostic step is duplicated.
- **Authoritative toolchain (`ubuntu-24.04`).** A separate, **generator-only**
  workflow ([`.github/workflows/authoritative-toolchain.yml`](.github/workflows/authoritative-toolchain.yml),
  not shipped to products) runs on the same triggers, on the platform the
  contract is recorded for. It installs the same pinned toolchain through mise
  (the only installation mechanism), proves `EMSDK` is present and exported,
  provisions the toolchain dependency domain, then runs the contract
  conformance check (`.`mise.toml` specification versus installed,
  toolchain), `deno task check:contracts` against the committed lock, and
  finally **verification by re-derivation**: it hashes the committed
  `toolchain-contracts.json`, runs `deno task contract:refresh` on the
  checked-out tree, and requires the hash to be unchanged. A difference prints
  the diff, restores the file and fails the job. That refresh is never
  committed — it exists to prove the record is reproducible on the authorised
  platform, and a mismatch is an investigation, not an invitation to refresh
  blindly. The job ends with `bash scripts/ci.sh build`.

The raw template is statically checked because its placeholder is not a valid
Worker name, which is why build validation happens in the throwaway copy. CI has
no Cloudflare secrets and never deploys.

For a local equivalent, run `mise exec -- deno task validate` for the static
checks and `mise exec -- bash scripts/ci.sh build` for build validation. The
workflow runs the individual static steps and `scripts/ci.sh build`, rather than
invoking `scripts/ci.sh all` itself, so a failing static gate cannot suppress the
build job.

Both jobs end at the conformance gate. Because the committed lock records this
repository's own facts, the gate passes while the environment matches it, and
fails the run when a source change moved a contract without a refreshed lock —
which is the review signal, not a workflow problem.

## Troubleshooting

### `mise install` is slow or fails

The first Emscripten SDK download is ~1.7 GB and needs network access. Ensure
`mise` is trusted (`mise trust`) and that the host has enough disk space.
Later installs reuse mise's caches.

### An untouched template refuses to start, build or deploy

This is expected. The placeholder is not a valid Worker name. Run the
initialiser first; on a fresh template, `deno task dev` surfaces the Wrangler
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

Emscripten's compiler driver is Python, and the project expects the host to
supply an interpreter that satisfies the SDK's requirement. Check the resolution the build will use:

```bash
scripts/resolve-python.sh
```

It prints the interpreter path, its version and the source (`EMSDK_PYTHON`,
`host python3` or `mise fallback`). If it reports that no usable interpreter
exists, either install the required Python for the host — preferred — or let
mise provision the documented fallback (the discovered minimum):

```bash
mise install "python@$(scripts/resolve-python.sh | sed -n 4p)"
```

An unsuitable `EMSDK_PYTHON` is reported as an error rather than replaced, so
unset it if it points at the wrong interpreter.

### The build says the toolchain is not installed

Provision it with:

```bash
mise exec -- deno task toolchain:install
```

The build resolves `tsc`, `vite` and `wrangler` from the installation rather than
from this checkout: there is no root `node_modules` to check. An absent or
incomplete installation is reported by name, and never repaired implicitly. The
build also
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

### `toolchain:install` fails on a lock mismatch

The committed [toolchain/deno.lock](toolchain/deno.lock) and
[toolchain/package.json](toolchain/package.json) disagree. Update the lockfile
intentionally (for example with `mise exec -- deno install` in `toolchain/`),
review the change to that lock, and commit it with the toolchain change. Do not
bypass `--frozen` in CI, and do not let an application dependency change reach
this lock: the two domains are independent.

### WSL: permission, executable-bit or symlink errors

Move the checkout into the Linux filesystem (for example `~/src/...`) and rerun
the command. Builds from `/mnt/c` are outside the supported environment.

### Deployment authentication fails

For non-interactive use, set `CLOUDFLARE_API_TOKEN` through your normal secret
mechanism. A dry run does not need either. There is no Node-hosted `wrangler`
wrapper: every Wrangler invocation goes through the Deno launchers, so an
interactive login is performed with the same launcher and profile:

```bash
mise exec -- deno run --allow-read --allow-env \
  --allow-run="$(readlink -f "$(command -v deno)")" \
  scripts/wrangler-deploy.mjs login
```

## Release operations: the toolchain provenance contract

A generated product does not carry the toolchain. It carries a reference to one
approved release of this generator, and CI reconstructs and verifies that
release before any product task runs.

### Release tags

- Format: `toolchain-YYYY.MM.N` (`YYYY.MM` the release month, `N` a positive
  sequence number). More than one release per month uses the next `N`.
- Tags **must be annotated**. A lightweight tag is refused, because the tag
  object carries no identity of its own.
- An annotated tag is **not intrinsically immutable**. Git permits deleting and
  recreating one. Repository administrators must protect the `toolchain-*` tag
  namespace against update and deletion; without that protection the tag is a
  label, not a guarantee.
- A release tag must **never be reused**. Producing a different tree under an
  existing release identifier defeats both halves of the contract.
- The **full commit SHA** is the authoritative implementation identity. The tag
  is the human-readable name for it.

### What a product records

`.toolchain-source.json` holds four fields: the fixed generator `repository`,
the `ref`, the full `sha`, and the `materialisation` digest of the dependency
tree that was accepted. Both halves are required: a correct commit with the
wrong dependency tree is not the accepted toolchain, and a matching tree from an
unidentified revision is not provenance.

### What product CI verifies

1. The metadata is validated against its schema, the fixed repository identity,
   the tag convention and both digest formats — before anything is written.
2. The recorded generator release is checked out and its commit SHA compared
   with the recorded SHA, and the ref is confirmed to be an annotated tag that
   resolves to that commit.
3. The toolchain is provisioned by that verified checkout, into an installation
   outside the product checkout, with a frozen lockfile.
4. The product-shipped verifier requires three identities to agree: the
   product's recorded digest, the installation's recorded digest, and the
   digest the verified generator's own implementation computes over the actual
   installed tree.

Missing, malformed, foreign, moveable or inconsistent provenance fails closed:
no provisioning and no product task runs. Release-qualified generation is
refused unless the generator working tree is clean (including untracked files),
the tag is annotated and resolves to the exact commit being released, and the
installed toolchain matches its own record.

### Digest comparison responsibilities

Materialisation, ordinary development, cross-environment consistency and
provenance are different claims, and each digest operation belongs to exactly
one of them:

| Operation | Where it runs | Purpose |
| --- | --- | --- |
| `deno task toolchain:install` digests the staging tree and records `spec`, `resolution`, `materialisation`, `implementation` in `toolchain.json` | Any environment that materialises the tree | **Materialisation correctness**: the installer reports what it produced |
| `deno task product:generate --toolchain-ref` reads that record and publishes `.toolchain-source.json` | The reference workstation (release path) | **Recording**, not auditing: the installer already observed the tree |
| `scripts/toolchain-source.mjs verify` compares the runner's **recorded and observed `implementation`** against the product's record | GitHub product CI | **Cross-environment consistency** — the one comparison only GitHub can make |
| Contract fingerprints (`check:contracts`, `contract:refresh` reproduction) | Both | **Declared versus observed agreement**; unrelated to tree immutability |

The whole-tree `materialisation` digest is machine-specific: it includes
installer state that legitimately differs per machine. It is recorded and
reported, and it is never compared across environments. Only `implementation`
is cross-machine comparable.

**Deferred requirement (R3).** The runner-side materialisation self-check — the
comparison of the runner's observed whole-tree digest against the
`materialisation` value in that runner's own installation record — is
**intentionally absent from ordinary product verification**. Because
materialisation is the installer's responsibility and the runner has just
materialised its own tree, the check restated a fact the installation had
already established.

- It is **deferred, not discarded**: when the GitHub provenance workflow becomes
  a real capability, this check must be reconsidered and restored *there* as
  provenance evidence, with explicit ownership, purpose and acceptance criteria.
- Its future owner is the **GitHub provenance workflow**, not product
  verification.
- It **must not silently reappear** in ordinary product verification: product
  verification keeps only the cross-environment `implementation` gates.
- The future provenance design must keep the distinction between
  machine-specific `materialisation` identity and cross-machine-comparable
  `implementation` identity; conflating them would make provenance
  machine-dependent.

### Status

The acceptance evidence in this workstream was produced with **disposable
repositories** and disposable toolchain roots. A disposable tag is not a
release. **No real release tag has been created or authorised**, and nothing in
this documentation constitutes one.

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
