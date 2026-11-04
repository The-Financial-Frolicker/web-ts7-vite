/**
 * The product manifest: the complete, positive allowlist of what a generated
 * project receives.
 *
 * This file is generator-only. It is the single source of truth for the
 * generator/product boundary, and it is deliberately an allowlist: a new file
 * added to the generator does not enter the product until someone adds it here
 * and explains why.
 *
 * Every entry is a path relative to the generator root. Directories are copied
 * recursively. Generated and machine-local paths (node_modules, dist,
 * build-wasm, .wrangler, .contracts, .git) are absent by construction.
 */

/** Product artefacts, grouped by the reason they are included. */
export const PRODUCT_MANIFEST = Object.freeze({
  /** Application source, assets and runtime configuration. */
  application: Object.freeze([
    "index.html",
    "src",
    "worker",
    "public",
    "wasm",
    "vite.config.ts",
    "tsconfig.json",
    "worker/tsconfig.json",
    "wrangler.jsonc",
    "worker-configuration.d.ts",
  ]),

  /** Project identity and dependency pinning. */
  project: Object.freeze([
    "package.json",
    "deno.json",
    "deno.lock",
    ".mise.toml",
    ".gitignore",
    "README.md",
    ".github/workflows/ci.yml",
  ]),

  /** The contract artefact the product inherits as-is (approved or bootstrap). */
  contract: Object.freeze([
    "toolchain-contracts.json",
  ]),

  /** Product-side verification and build/validation tooling. */
  tooling: Object.freeze([
    "scripts/build.sh",
    "scripts/build-wasm.sh",
    "scripts/ci.sh",
    "scripts/deploy.sh",
    "scripts/deploy-dry-run.sh",
    "scripts/deno-no-node.sh",
    "scripts/resolve-python.sh",
    "scripts/worker-types.sh",
    "scripts/check-contracts.sh",
    "scripts/check-deploy-artifacts.mjs",
    "scripts/check-deploy-artifacts.test.mjs",
    "scripts/check-node-boundary.mjs",
    "scripts/check-node-boundary.test.mjs",
    "scripts/vite-build.mjs",
    "scripts/vite-build.test.mjs",
    "scripts/wrangler-types.mjs",
    "scripts/wrangler-types.test.mjs",
    "scripts/wrangler-dry-run.mjs",
    "scripts/wrangler-dry-run.test.mjs",
    "scripts/build-scripts.test.mjs",
    "scripts/deno-no-node.test.mjs",
    "scripts/contracts.verify.test.mjs",
    "scripts/contract-accept.test.mjs",
    "scripts/lib/assert.mjs",
    "scripts/lib/command.mjs",
    "scripts/lib/fs.mjs",
    "scripts/lib/os.mjs",
    "scripts/lib/path.mjs",
    "scripts/lib/test.mjs",
    "scripts/lib/toolchain/discovery.mjs",
    "scripts/contracts/canonical.mjs",
    "scripts/contracts/schema.mjs",
    "scripts/contracts/config.mjs",
    "scripts/contracts/scopes.mjs",
    "scripts/contracts/store.mjs",
    "scripts/contracts/toolchain.mjs",
    "scripts/contracts/permissions.mjs",
    "scripts/contracts/verify.mjs",
    "scripts/contracts/cli.mjs",
  ]),
});

/** Flat list of product paths. */
export function productPaths() {
  return Object.values(PRODUCT_MANIFEST).flat();
}

/**
 * Generator-only paths that must never appear in a product.
 *
 * Listed explicitly so a test can assert their absence rather than relying on
 * "the allowlist probably did not include them".
 */
export const GENERATOR_ONLY = Object.freeze([
  "scripts/init-project.mjs",
  "scripts/init-project.test.mjs",
  "scripts/contracts.test.mjs",
  // Generator-side provenance/scope regression tests. A product ships the
  // verifier and its tests, but not the suite that records how the generator
  // measured and derived the contract's scope evidence.
  "scripts/emscripten-provenance.test.mjs",
  "scripts/toolchain.test.mjs",
  "scripts/generate-product.test.mjs",
  "scripts/contract-discover.sh",
  "scripts/contract-approve.sh",
  "scripts/lib/toolchain/vite.mjs",
  "scripts/lib/toolchain/vite-probe.mjs",
  "scripts/contracts/discover.mjs",
  "scripts/contracts/fixtures.mjs",
  "scripts/contracts/workerd-probe.mjs",
  "scripts/contracts/approve.mjs",
  "scripts/contracts/author-cli.mjs",
  // The generator itself: the product manifest and the generation operation.
  "scripts/product-manifest.mjs",
  "scripts/generate-product.mjs",
  // Toolchain management is generator-only. A product inherits the pinned
  // `.mise.toml` projection and never re-resolves or re-pins the toolchain used
  // to create it, so the authoritative configuration, the resolver and its
  // tests must not travel with it.
  "toolchain.toml",
  "scripts/toolchain-prepare.mjs",
  "scripts/toolchain-config.test.mjs",
  "scripts/lib/toolchain/versions.mjs",
  "scripts/lib/toolchain/resolve.mjs",
  ".contracts",
]);

/** Fail closed if the two lists ever overlap. */
export function assertManifestDisjoint() {
  const product = new Set(productPaths());
  const overlap = GENERATOR_ONLY.filter((entry) => product.has(entry));
  if (overlap.length > 0) {
    throw new Error(
      `generator-only paths are also listed as product artefacts: ${
        overlap.join(", ")
      }`,
    );
  }
}
