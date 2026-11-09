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
 *
 * The Cloudflare Vite plugin is not consulted: it is deployment integration,
 * owned by the Deno application dependency domain. Its runtime is compared with
 * Wrangler's at the deployment boundary, so this build-toolchain certificate
 * never depends on it.
 *
 * Nothing here executes a binary. Execution belongs to `discover.mjs`, which is
 * a local-only operation; CI must be able to compute the same fingerprint from
 * files alone.
 */

import { findPackage } from "../lib/toolchain/discovery.mjs";
import { resolveWorkerdRuntime } from "../lib/cloudflare/workerd-runtime.mjs";
import path from "../lib/path.mjs";
import { readFileSync } from "../lib/fs.mjs";

/** The tools whose versions the operator specifies on the command line. */
export const SPECIFIED_TOOLS = Object.freeze([
  "deno",
  "vite",
  "wrangler",
  "emscripten",
]);

/**
 * The mise tool identifier for each supplied tool.
 *
 * Emscripten's mise tool is `emsdk`; Vite and Wrangler are installed through
 * mise's npm backend. This map is the only place the identity is stated, and
 * both the rendered `.mise.toml` and the availability guard use it, so the file
 * and the check cannot disagree.
 */
export const MISE_TOOL_ID = Object.freeze({
  deno: "deno",
  vite: "npm:vite",
  wrangler: "npm:wrangler",
  emscripten: "emsdk",
});

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

function requireInstalled(root, name, version, why) {
  try {
    return findPackage(root, name, version === undefined ? {} : { version });
  } catch (error) {
    fail(`${why}: ${error.message}`);
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

    // A declaration key may be bare (`deno`) or quoted when it names a backend
    // (`"npm:vite"`). Both forms are the project configuration mise reads.
    const match = /^(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*=\s*"([^"]*)"/
      .exec(trimmed);
    if (match !== null) pins[match[1] ?? match[2]] = match[3];
  }

  return pins;
}

/**
 * The supplied toolchain tuple, as declared in the project's mise configuration.
 *
 * The four versions are the toolchain definition. `toolchain:specify` is the
 * only writer of `.mise.toml`, it writes exactly the versions supplied on the
 * command line, and it refuses a tuple that is incomplete, malformed or not
 * available through mise; so this reads the supplied tuple rather than an
 * observation. Nothing is probed or re-resolved here, and the build
 * prerequisites cmake/ninja are deliberately excluded: they are not the tuple.
 */
export function readToolchainTuple(root) {
  const pins = readMisePins(root);
  const tuple = {};

  for (const tool of SPECIFIED_TOOLS) {
    const id = MISE_TOOL_ID[tool];
    const declared = pins[id];
    if (typeof declared !== "string" || !/^\d+\.\d+\.\d+$/.test(declared)) {
      const shown = JSON.stringify(id);
      fail(
        `.mise.toml declares no exact ${shown} version, so the toolchain ` +
          `tuple is incomplete; run \`deno task toolchain:specify\` with the ` +
          `four supplied versions`,
      );
    }
    tuple[tool] = declared;
  }

  return tuple;
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
 * The workerd runtime the certified build toolchain executes.
 *
 * Wrangler is a tuple member: its runtime is what type generation, the
 * deployment dry run and deployment execute, so it is a build-toolchain fact.
 * The resolution walk itself is shared with the deployment boundary
 * (`lib/cloudflare/workerd-runtime.mjs`); this module contributes the policy that
 * only Wrangler is certified.
 *
 * The Cloudflare Vite plugin is deliberately *not* resolved here. It is
 * deployment integration owned by the Deno application dependency domain, and
 * whether its runtime agrees with Wrangler's is a deployment compatibility
 * question, checked at the deployment boundary.
 */
export function resolveWorkerdGraph(root) {
  const runtime = resolveWorkerdRuntime(root, "wrangler", {
    platform: platformIdentity(),
  });

  return {
    binary: runtime.binary,
    workerdVersion: runtime.workerdVersion,
    platformPackage: runtime.platformPackage,
    wranglerVersion: runtime.packageVersion,
    miniflare: [runtime],
    detail: `Wrangler ${runtime.packageVersion} resolves workerd ` +
      `${runtime.workerdVersion}`,
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
    // The authoritative toolchain definition: the four versions supplied to
    // `toolchain:specify`. Distinct from the findings that follow, which
    // describe what the installed toolchain turned out to support.
    tuple: {
      ...readToolchainTuple(root),
      evidence: ".mise.toml [tools] as written by `toolchain:specify`",
    },
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
