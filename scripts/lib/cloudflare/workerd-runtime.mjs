/**
 * Workerd runtime resolution for a Cloudflare package graph.
 *
 * One shared capability, used by two callers with different policies:
 *
 *   * toolchain certification asks what runtime the *Wrangler* graph selects
 *     (a build-toolchain fact, recorded in `toolchain-contracts.json`);
 *   * the deployment boundary asks whether the *Wrangler* and *Cloudflare Vite
 *     plugin* graphs select the *same* runtime (a deployment-integration fact,
 *     never recorded in the certificate).
 *
 * This module resolves only. It holds no certification policy, no deployment
 * policy, mutates nothing and defines no comparison: callers decide what the
 * result means.
 *
 * The walk is the one the certificate has always performed:
 *
 *   owner/package.json   -> declared miniflare version
 *   miniflare/package.json -> declared workerd version
 *   workerd/package.json  -> platform package holding the binary
 *   <platform package>/bin/workerd
 *
 * Every step is resolved through `findPackage`, so an exact version is honoured
 * and an ambiguous installation is refused rather than guessed.
 */

import { findPackage } from "../toolchain/discovery.mjs";
import path from "../path.mjs";

export class WorkerdRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkerdRuntimeError";
  }
}

function fail(message) {
  throw new WorkerdRuntimeError(message);
}

/** This platform, in the form `workerd`'s platform packages use. */
export function currentPlatform() {
  const os = Deno.build.os;
  const arch = Deno.build.arch;
  const libc = os === "linux" ? Deno.build.env ?? "gnu" : undefined;
  return { os, arch, ...(libc === undefined ? {} : { libc }) };
}

function installed(root, name, version, why) {
  try {
    return findPackage(root, name, version === undefined ? {} : { version });
  } catch (error) {
    fail(`${why}: ${error.message}`);
  }
}

function declaredDependency(manifest, name, owner) {
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
    if (error instanceof WorkerdRuntimeError) throw error;
    fail(`${label} is missing or unreadable: ${file} (${error.message})`);
  }
}

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

/**
 * Resolve the workerd runtime that `packageName`'s dependency graph selects.
 *
 * Returns the runtime evidence both callers need and nothing about what it
 * means. `nodeModules` is the installed dependency tree to resolve within;
 * `platform` defaults to this machine.
 */
export function resolveWorkerdRuntime(
  nodeModules,
  packageName,
  { platform } = {},
) {
  const target = platform ?? currentPlatform();

  const owner = installed(
    nodeModules,
    packageName,
    undefined,
    `the ${packageName} package`,
  );
  const ownerVersion = owner.manifest.version;
  const miniflareVersion = declaredDependency(
    owner.manifest,
    "miniflare",
    `${packageName}@${ownerVersion}`,
  );
  const miniflare = installed(
    nodeModules,
    "miniflare",
    miniflareVersion,
    `Miniflare required by ${packageName}@${ownerVersion}`,
  );
  const workerdVersion = declaredDependency(
    miniflare.manifest,
    "workerd",
    `miniflare@${miniflareVersion}`,
  );
  const workerd = installed(
    nodeModules,
    "workerd",
    workerdVersion,
    `workerd required by miniflare@${miniflareVersion}`,
  );

  const platformPackage = workerdPlatformPackage(workerd.manifest, target);
  const installedPlatform = installed(
    nodeModules,
    platformPackage.name,
    platformPackage.version,
    `workerd platform package for ${target.os}/${target.arch}`,
  );
  const binary = realFile(
    path.join(installedPlatform.dir, "bin", "workerd"),
    `${platformPackage.name} workerd executable`,
  );

  return {
    packageName,
    packageVersion: ownerVersion,
    miniflareVersion,
    miniflarePath: miniflare.dir,
    requiredBy: `${packageName}@${ownerVersion}`,
    workerdVersion,
    workerdPath: workerd.dir,
    platformPackage: `${platformPackage.name}@${platformPackage.version}`,
    binary,
  };
}
