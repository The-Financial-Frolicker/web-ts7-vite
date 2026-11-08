/**
 * Toolchain-owned TypeScript check launcher.
 *
 *   deno run … scripts/tsc-check.mjs <tsconfig>   typecheck one project
 *   … --print-profile                             report the resolved compiler
 *
 * The compiler is the toolchain's native TypeScript binary, resolved from the
 * installed toolchain. Nothing here consults Deno's global npm cache and nothing
 * writes into the toolchain tree.
 *
 * The application's tsconfig may name toolchain packages for ambient types (the
 * client config lists `vite/client`). Those packages live in the toolchain
 * domain, so the launcher writes a machine-local overlay — inside the
 * application's ignored `.wrangler/` state — that keeps the application's own
 * settings and points type resolution at the installation. The overlay is
 * derived state: it is never committed, and it never lives in the toolchain.
 */

import { dirname, join } from "./lib/path.mjs";
import { readFileSync } from "./lib/fs.mjs";
import { runtimePolicy } from "./lib/toolchain/runtime.mjs";
import { stripJsonc } from "./contracts/config.mjs";

/** Platform package that carries the native compiler for this host. */
export function typescriptPlatformPackage() {
  const arch = { x86_64: "x64", aarch64: "arm64", arm: "arm", ia32: "ia32" }[
    Deno.build.arch
  ];
  const os =
    { linux: "linux", darwin: "darwin", win32: "win32" }[Deno.build.os];
  if (arch === undefined || os === undefined) {
    throw new Error(
      `no native TypeScript package for ${Deno.build.os}/${Deno.build.arch}`,
    );
  }
  return `@typescript/typescript-${os}-${arch}`;
}

/** Resolve a package directory inside the installation. */
export function findPackage(nodeModules, name) {
  const flat = join(nodeModules, name);
  try {
    if (Deno.statSync(flat).isDirectory) return flat;
  } catch {
    // Fall through to the content-addressed store.
  }

  const store = join(nodeModules, ".deno");
  let entries = [];
  try {
    entries = [...Deno.readDirSync(store)].map((entry) => entry.name).sort();
  } catch {
    throw new Error(`no dependency tree at ${nodeModules}`);
  }

  for (const entry of entries) {
    const candidate = join(store, entry, "node_modules", name);
    try {
      if (Deno.statSync(candidate).isDirectory) return candidate;
    } catch {
      // Not this entry.
    }
  }

  throw new Error(`${name} is not installed in ${nodeModules}`);
}

/** Split a `types` specifier into its package and optional subpath. */
export function splitTypeSpecifier(specifier) {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return {
      packageName: parts.slice(0, 2).join("/"),
      subpath: parts.slice(2).join("/"),
    };
  }
  return { packageName: parts[0], subpath: parts.slice(1).join("/") };
}

/** The native compiler executable. */
export function resolveTsc(generatorInstallationRoot) {
  const packageDir = findPackage(
    join(generatorInstallationRoot, "node_modules"),
    typescriptPlatformPackage(),
  );
  const tsc = join(packageDir, "lib", "tsc");
  if (!Deno.statSync(tsc).isFile) {
    throw new Error(`no compiler executable at ${tsc}`);
  }
  return Deno.realPathSync(tsc);
}

/**
 * Overlay configuration for one application project.
 *
 * Keeps every application setting, rewrites `include` to absolute application
 * paths (the overlay lives elsewhere) and maps each `types` entry that names a
 * toolchain package to its installed declaration file.
 */
export function overlayConfig(
  appRoot,
  tsconfigPath,
  generatorInstallationRoot,
) {
  const config = JSON.parse(
    stripJsonc(readFileSync(join(appRoot, tsconfigPath), "utf8")),
  );
  const compilerOptions = { ...(config.compilerOptions ?? {}) };

  // A `types` entry naming a toolchain package cannot be resolved by name from
  // the application (the package lives in the toolchain), and `paths` is not
  // consulted for `types`. Such a declaration is an ambient file, so it joins
  // the program through `files` instead and leaves `types` for real @types
  // packages.
  const files = (config.files ?? []).map((entry) =>
    join(appRoot, dirname(tsconfigPath), entry)
  );
  const unresolved = [];
  for (const name of compilerOptions.types ?? []) {
    try {
      const { packageName, subpath } = splitTypeSpecifier(name);
      const packageDir = findPackage(
        join(generatorInstallationRoot, "node_modules"),
        packageName,
      );
      files.push(
        join(
          packageDir,
          subpath.length === 0 ? "index.d.ts" : `${subpath}.d.ts`,
        ),
      );
    } catch {
      unresolved.push(name);
    }
  }
  compilerOptions.types = unresolved;

  // Include patterns are relative to the tsconfig that declares them, and the
  // overlay lives elsewhere, so every entry becomes an absolute path.
  const include = (config.include ?? []).map((entry) =>
    join(appRoot, dirname(tsconfigPath), entry)
  );

  // Files already covered by `include` must not be listed twice.
  const overlay = { ...config, compilerOptions, include };

  // The application's worker config declares no types, so the usual case is
  // that nothing extra enters `files`; an ambient toolchain declaration does.
  if (files.length > 0) overlay.files = files;

  return overlay;
}

/** CLI entry point; returns an exit code. */
export function main(
  argv = Deno.args,
  appRoot = Deno.cwd(),
  io = console,
  execute = runChild,
) {
  const printProfile = argv.includes("--print-profile");
  const [tsconfigPath] = argv.filter((argument) =>
    argument !== "--print-profile"
  );

  try {
    if (typeof tsconfigPath !== "string" || tsconfigPath.length === 0) {
      throw new Error("usage: tsc-check.mjs <tsconfig> [--print-profile]");
    }

    const policy = runtimePolicy(appRoot);
    const tsc = resolveTsc(policy.generatorInstallationRoot);

    // Resolve-only mode: the shell entry point asks once for the compiler path,
    // so it can grant `--allow-run` on the exact executable without duplicating
    // any generator-root or platform resolution here.
    if (argv.includes("--print-tsc")) {
      io.log(tsc);
      return 0;
    }

    // Derived configuration lives in the application's ignored state, never in
    // the toolchain installation.
    const overlayDir = join(appRoot, ".wrangler", "tsc");
    const overlay = join(overlayDir, `${tsconfigPath.replace(/[\\/]/g, "-")}`);
    Deno.mkdirSync(dirname(overlay), { recursive: true });
    Deno.writeTextFileSync(
      overlay,
      `${
        JSON.stringify(
          overlayConfig(
            appRoot,
            tsconfigPath,
            policy.generatorInstallationRoot,
          ),
          null,
          2,
        )
      }\n`,
    );

    if (printProfile) {
      io.log(
        JSON.stringify(
          {
            tsc,
            overlay,
            generatorInstallationRoot: policy.generatorInstallationRoot,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    io.error(
      `TypeScript: ${tsc} -p ${overlay} (toolchain ${policy.generatorInstallationRoot})`,
    );
    return execute(tsc, ["-p", overlay], appRoot);
  } catch (error) {
    io.error(`TypeScript check failed: ${error.message}`);
    return 1;
  }
}

function runChild(command, args, cwd) {
  const result = new Deno.Command(command, {
    args,
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).outputSync();
  return result.code;
}

if (import.meta.main) {
  Deno.exitCode = main();
}
