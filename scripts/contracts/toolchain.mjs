/**
 * Installed toolchain identity and workerd resolution.
 *
 * The contract must describe the tools the *project workflow* uses, not the
 * first executable on `PATH`. Everything here is resolved from the installed
 * dependency graph and the project's own configuration:
 *
 *   wrangler/package.json                -> miniflare version it requires
 *   miniflare/package.json               -> workerd version it requires
 *   workerd/package.json                 -> platform package holding the binary
 *   @cloudflare/vite-plugin/package.json -> the second graph, used as a check
 *
 * Nothing here executes a binary. Execution belongs to `discover.mjs`, which is
 * a local-only operation; CI must be able to compute the same fingerprint from
 * files alone.
 */

import { findPackage } from "../lib/toolchain/discovery.mjs";
import path from "../lib/path.mjs";
import { readFileSync } from "../lib/fs.mjs";

export class ToolchainError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolchainError";
  }
}

function fail(message) {
  throw new ToolchainError(message);
}

/** Platform identity used as a fingerprint input. */
export function platformIdentity() {
  const os = Deno.build.os;
  const arch = Deno.build.arch;
  const libc = os === "linux" ? Deno.build.env ?? "gnu" : undefined;

  return {
    os,
    arch,
    ...(libc === undefined ? {} : { libc }),
    key: libc === undefined ? `${os}-${arch}` : `${os}-${arch}-${libc}`,
  };
}

/**
 * Pick the platform package from the manifest's own optionalDependencies.
 *
 * The naming is not derivable from `Deno.build` alone (`linux-64`, not
 * `linux-x64`; `windows-64`, not `win32-x64`), so it is matched against the
 * names the installed package actually offers. A missing match is an error, not
 * a guess.
 */
function workerdPlatformPackage(manifest, platform) {
  const os = { win32: "windows" }[platform.os] ?? platform.os;
  const arch = { x86_64: "64", aarch64: "arm64", arm: "arm", ia32: "ia32" }[
    platform.arch
  ] ?? platform.arch;
  const optional = manifest.optionalDependencies ?? {};

  for (const suffix of [`${os}-${arch}`, `${os}-x${arch}`]) {
    const name = `@cloudflare/workerd-${suffix}`;
    if (typeof optional[name] === "string") {
      return { name, version: optional[name] };
    }
  }

  fail(
    `workerd@${manifest.version} does not offer a runtime for ` +
      `${platform.os}/${platform.arch}; it offers ` +
      `${Object.keys(optional).join(", ") || "nothing"}`,
  );
}

function requireInstalled(root, name, version, why) {
  try {
    return findPackage(root, name, version === undefined ? {} : { version });
  } catch (error) {
    fail(`${why}: ${error.message}`);
  }
}

function requireDependency(manifest, name, owner) {
  const version = manifest.dependencies?.[name] ??
    manifest.optionalDependencies?.[name];
  if (typeof version !== "string" || version.length === 0) {
    fail(`${owner} does not declare a ${name} dependency`);
  }
  return version;
}

function realFile(file, label) {
  try {
    if (!Deno.statSync(file).isFile) fail(`${label} is not a file: ${file}`);
    return Deno.realPathSync(file);
  } catch (error) {
    if (error instanceof ToolchainError) throw error;
    fail(`${label} is missing or unreadable: ${file} (${error.message})`);
  }
}

/** Read the pinned tool versions from `.mise.toml` without a TOML parser. */
export function readMisePins(root) {
  let text;
  try {
    text = readFileSync(path.join(root, ".mise.toml"), "utf8");
  } catch {
    return {};
  }

  const pins = {};
  let inTools = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inTools = trimmed === "[tools]";
      continue;
    }
    if (!inTools || trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/.exec(trimmed);
    if (match !== null) pins[match[1]] = match[2];
  }

  return pins;
}

/** Direct dependency versions from `deno.lock` specifiers, when present. */
export function readLockSpecifiers(root) {
  try {
    const lock = JSON.parse(readFileSync(path.join(root, "deno.lock"), "utf8"));
    return lock.specifiers ?? {};
  } catch {
    return {};
  }
}

/**
 * Known packages that carry authoritative browser-compatibility data.
 *
 * The client API edition can only be *derived* if one of these is installed;
 * otherwise it stays a declared policy. Recording what was checked — and what
 * was found — is the evidence for that decision, and it keeps the project from
 * quietly acquiring a compatibility database it does not actually consult.
 */
export const BROWSER_COMPAT_PACKAGES = Object.freeze([
  "@mdn/browser-compat-data",
  "browser-compat-data",
  "caniuse-lite",
  "browserslist",
]);

/** Check the installed graph for a browser-compatibility database. */
export function discoverBrowserCompatSources(root) {
  const available = [];
  const missing = [];

  for (const name of BROWSER_COMPAT_PACKAGES) {
    try {
      const found = findPackage(root, name);
      available.push({ name, version: found.manifest.version });
    } catch {
      missing.push(name);
    }
  }

  return {
    checked: [...BROWSER_COMPAT_PACKAGES],
    available,
    missing,
    evidence: available.length === 0
      ? "no installed package carries a browser-compatibility database, so " +
        "the client API edition remains a declared policy"
      : "installed browser-compatibility data is available but is not " +
        "consulted automatically; the client API edition remains declared",
  };
}

/**
 * Resolve the workerd binary selected by the Wrangler and Vite plugin graphs.
 *
 * Both graphs are resolved because the project uses both: Wrangler for type
 * generation and deployment, the Vite plugin for the build. They must agree on
 * the runtime, otherwise one capability contract cannot describe the workflow.
 */
export function resolveWorkerdGraph(root) {
  const platform = platformIdentity();

  const wrangler = requireInstalled(root, "wrangler", undefined, "Wrangler");
  const wranglerVersion = wrangler.manifest.version;
  const wranglerTree = resolveMiniflareTree(
    root,
    requireDependency(
      wrangler.manifest,
      "miniflare",
      `wrangler@${wranglerVersion}`,
    ),
    `wrangler@${wranglerVersion}`,
    platform,
  );

  const vitePlugin = requireInstalled(
    root,
    "@cloudflare/vite-plugin",
    undefined,
    "the Cloudflare Vite plugin",
  );
  const vitePluginVersion = vitePlugin.manifest.version;
  const pluginTree = resolveMiniflareTree(
    root,
    requireDependency(
      vitePlugin.manifest,
      "miniflare",
      `@cloudflare/vite-plugin@${vitePluginVersion}`,
    ),
    `@cloudflare/vite-plugin@${vitePluginVersion}`,
    platform,
  );

  const consistent =
    wranglerTree.workerdVersion === pluginTree.workerdVersion &&
    wranglerTree.binary === pluginTree.binary;

  return {
    binary: wranglerTree.binary,
    workerdVersion: wranglerTree.workerdVersion,
    platformPackage: wranglerTree.platformPackage,
    wranglerVersion,
    vitePluginVersion,
    miniflare: [wranglerTree, pluginTree],
    consistent,
    detail: consistent
      ? `Wrangler ${wranglerVersion} and @cloudflare/vite-plugin ` +
        `${vitePluginVersion} both resolve workerd ${wranglerTree.workerdVersion}`
      : `Wrangler ${wranglerVersion} resolves workerd ` +
        `${wranglerTree.workerdVersion}, but @cloudflare/vite-plugin ` +
        `${vitePluginVersion} resolves ${pluginTree.workerdVersion}; one ` +
        `contract cannot describe two runtimes`,
  };
}

function resolveMiniflareTree(
  root,
  miniflareVersion,
  requiredBy,
  platform,
) {
  const miniflare = requireInstalled(
    root,
    "miniflare",
    miniflareVersion,
    `Miniflare required by ${requiredBy}`,
  );
  const workerdVersion = requireDependency(
    miniflare.manifest,
    "workerd",
    `miniflare@${miniflareVersion}`,
  );
  const workerd = requireInstalled(
    root,
    "workerd",
    workerdVersion,
    `workerd required by miniflare@${miniflareVersion}`,
  );

  const platformPackage = workerdPlatformPackage(workerd.manifest, platform);
  const installedPlatform = requireInstalled(
    root,
    platformPackage.name,
    platformPackage.version,
    `workerd platform package for ${platform.key}`,
  );
  const binary = realFile(
    path.join(installedPlatform.dir, "bin", "workerd"),
    `${platformPackage.name} workerd executable`,
  );

  return {
    miniflareVersion,
    miniflarePath: miniflare.dir,
    requiredBy,
    workerdVersion,
    workerdPath: workerd.dir,
    platformPackage: `${platformPackage.name}@${platformPackage.version}`,
    binary,
  };
}

/** Package identities that a contract's fingerprint is computed over. */
export function resolvePackageIdentity(root) {
  return {
    typescript: requireInstalled(root, "typescript", undefined, "TypeScript"),
    vite: requireInstalled(root, "vite", undefined, "Vite"),
    graph: resolveWorkerdGraph(root),
  };
}

/**
 * Describe a path for a committed artefact.
 *
 * A lock is committed and reviewed, so it must not embed the authoring machine's
 * layout. A path inside the project is recorded relative to the root; anything
 * else — a shared package store, a global cache, a `node_modules` symlink — is
 * recorded as `<external>/<basename>`. That stays byte-identical across machines
 * without hiding which artefact was used.
 */
export function describePath(root, value) {
  const relativePath = path.relative(root, value);
  if (relativePath === "") return ".";
  if (!relativePath.startsWith("..")) return relativePath;
  return `<external>/${path.basename(value)}`;
}

/**
 * Build the informational identity block recorded in the contract document.
 *
 * These values explain *what was present* when the contract was approved. Only
 * the subset listed in each contract's `fingerprintInputs` can invalidate that
 * contract; everything else here is provenance for a human reader.
 *
 * Paths are stored relative to the project root: a contract is a committed
 * artefact, so a path from the machine that authored it must never leak into it.
 */
export function describeToolchain(root, generatorInstallationRoot = root) {
  const platform = platformIdentity();
  const pins = readMisePins(root);
  const specifiers = readLockSpecifiers(generatorInstallationRoot);
  const { typescript, vite, graph } = resolvePackageIdentity(
    generatorInstallationRoot,
  );
  const relative = (value) => describePath(root, value);

  return {
    deno: {
      version: Deno.version.deno,
      evidence: "Deno.version.deno of the process that authored the contract",
    },
    platform: {
      os: platform.os,
      arch: platform.arch,
      ...(platform.libc === undefined ? {} : { libc: platform.libc }),
      key: platform.key,
      evidence: "Deno.build",
    },
    mise: { pins, evidence: ".mise.toml [tools]" },
    lockfile: { specifiers, evidence: "deno.lock specifiers" },
    emscripten: describeEmscripten(root),
    browserCompatSources: discoverBrowserCompatSources(
      generatorInstallationRoot,
    ),
    packages: {
      typescript: {
        version: typescript.manifest.version,
        path: relative(typescript.dir),
        evidence: "installed package manifest",
      },
      vite: {
        version: vite.manifest.version,
        path: relative(vite.dir),
        evidence: "installed package manifest",
      },
      wrangler: {
        version: graph.wranglerVersion,
        evidence: "installed package manifest",
      },
      vitePlugin: {
        version: graph.vitePluginVersion,
        evidence: "installed package manifest",
      },
      miniflare: graph.miniflare.map((tree) => ({
        version: tree.miniflareVersion,
        requiredBy: tree.requiredBy,
        workerd: tree.workerdVersion,
        evidence: "installed package manifest",
      })),
      workerd: {
        version: graph.workerdVersion,
        platformPackage: graph.platformPackage,
        binary: relative(graph.binary),
        consistent: graph.consistent,
        evidence: graph.detail,
      },
    },
  };
}

/**
 * Capture Emscripten build provenance.
 *
 * Read-only and deterministic: only files are inspected. Nothing here executes
 * a compiler, so no build is triggered and no broad permission is needed.
 *
 * Fields that cannot be established from files are recorded as unavailable with
 * the reason. In particular the LLVM revision is never inferred from the clang
 * version, and no field silently disappears.
 *
 * The installation root is deliberately not recorded: provenance is committed,
 * so a path from this machine must not be embedded in it.
 */
export function describeEmscripten(root, env = Deno.env) {
  const pins = readMisePins(root);
  const sdkRoot = env.get("EMSDK") ?? null;
  const unavailable = (reason) => ({
    value: null,
    available: false,
    reason,
  });

  const provenance = {
    sdkVersion: typeof pins.emsdk === "string"
      ? {
        value: pins.emsdk,
        available: true,
        source: ".mise.toml [tools] emsdk",
      }
      : unavailable("no emsdk pin in .mise.toml"),
    emscriptenVersion: unavailable("EMSDK is not set in this environment"),
    clangVersion: unavailable(
      "requires executing the SDK's compiler; not inferred from the " +
        "Emscripten version",
    ),
    llvmRevision: unavailable(
      "requires executing the SDK's compiler; never inferred from the clang " +
        "version",
    ),
    standardLibrary: unavailable("EMSDK is not set in this environment"),
    target: unavailable("requires running `emcc -dumpmachine`"),
    installation: {
      available: false,
      reason: "EMSDK is not set in this environment",
      markers: null,
    },
  };

  if (sdkRoot === null) return provenance;

  const markers = {};
  const probeFile = (label, relative) => {
    try {
      return {
        label,
        present: Deno.statSync(`${sdkRoot}/${relative}`).isFile,
      };
    } catch {
      return { label, present: false };
    }
  };

  try {
    const version = readFileSync(
      `${sdkRoot}/upstream/emscripten/emscripten-version.txt`,
      "utf8",
    ).trim();
    if (version.length > 0) {
      provenance.emscriptenVersion = {
        value: version,
        available: true,
        source: "upstream/emscripten/emscripten-version.txt",
      };
    }
  } catch {
    provenance.emscriptenVersion = unavailable(
      "upstream/emscripten/emscripten-version.txt is not readable",
    );
  }

  for (
    const [label, relative] of [
      ["clang", "upstream/bin/clang"],
      ["emscripten", "upstream/emscripten/emcc"],
      ["libcxx", "upstream/emscripten/system/lib/libcxx"],
    ]
  ) {
    markers[label] = probeFile(label, relative).present;
  }

  provenance.installation = {
    available: true,
    reason: "EMSDK is set; only layout markers are recorded",
    markers,
  };

  if (markers.libcxx === true) {
    provenance.standardLibrary = {
      value: "sdk-provided",
      available: true,
      reason:
        "upstream/emscripten/system/lib/libcxx is present; the SDK does " +
        "not expose a separate libc++ version file",
    };
  } else {
    // EMSDK is set here, so the reason must not claim otherwise: this SDK simply
    // has no libc++ marker at the expected path, and the value stays unrecorded
    // rather than being guessed from the Emscripten version.
    provenance.standardLibrary = unavailable(
      "the SDK has no upstream/emscripten/system/lib/libcxx marker; the C++ " +
        "standard library is not identified from paths",
    );
  }

  return provenance;
}
