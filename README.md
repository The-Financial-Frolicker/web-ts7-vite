# web-ts7-vite

Browser app + Cloudflare Worker + WebAssembly, built with Vite and Emscripten.

## Prerequisites

This project needs **two** independent toolchains:

1. **Node.js 24.19.0** — supplied and pinned by [mise](https://mise.jdx.dev/), declared in `.mise.toml`.
   The project requires Node **>= 22.12.0** (see `engines.node` in `package.json`); `.mise.toml`
   pins the exact known-good version for reproducible builds.
2. **Emscripten SDK (emsdk)** at `/opt/emsdk` (override with `EMSDK_ROOT`) — provides the
   `em++`, `cmake` and `ninja` compiler toolchain for the WebAssembly module.

The two are kept separate on purpose: `scripts/build.sh` sources `emsdk_env.sh` only to obtain
the compiler tools, then re-asserts the mise-managed Node at the front of `PATH`, so Emscripten
never silently replaces the project Node runtime.

## Setup (WSL / Ubuntu)

### 1. Install mise

```bash
curl https://mise.run | sh        # installs the mise binary
echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc
source ~/.bashrc
```

Restart your shell (or `source ~/.bashrc`) so mise's activation hook is active.

### 2. Install the project Node version

From the project root, trust and install the pinned version:

```bash
mise trust          # trust the project's .mise.toml (first time only)
mise install        # installs Node 24.19.0 (from .mise.toml)
```

### 3. Verify

```bash
node --version      # should print v24.19.0
mise current        # should show node 24.19.0 for this project
```

### 4. Emscripten SDK

Ensure emsdk is present at `/opt/emsdk` (or export `EMSDK_ROOT` to its location).
You do **not** need to source `emsdk_env.sh` yourself — `scripts/build.sh` does that and
keeps Node resolution on the mise-managed runtime.

## Common tasks

```bash
mise exec -- deno task build              # full build (WASM + typecheck + Vite)
mise exec -- deno task test:wasm          # build-tree WASM smoke test
mise exec -- deno task test:wasm:published# published (dist/client) WASM smoke test
```

`mise exec --` runs a command with the project Node on `PATH`. If mise is already active in
your shell, the plain `deno task …` / `npm run …` forms work too. The `#!/usr/bin/env node`
shims in `node_modules/.bin` (used by `tsc` and `vite`) and the `node …` test commands all
resolve to the mise-managed Node when run from an activated project environment.
