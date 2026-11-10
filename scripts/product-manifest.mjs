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
    "scripts/deploy-artefact.sh",
    "scripts/deploy-artefact-dry-run.sh",
    "scripts/artefact.mjs",
    "scripts/artefact.test.mjs",
    // The deployment installation is application-scoped (Deno owns the
    // deployment dependency tree), so a product provisions its own from this
    // specification rather than borrowing the generator's toolchain closure.
    "scripts/deployment-install.mjs",
    "scripts/deployment-install.test.mjs",
    "deployment/package.json",
    "deployment/deno.json",
    "deployment/deno.lock",
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
    "scripts/vite-server.mjs",
    "scripts/vite-server.test.mjs",
    "scripts/serve.sh",
    "scripts/tsc-check.mjs",
    "scripts/tsc-check.sh",
    "scripts/toolchain-source.mjs",
    "scripts/lib/toolchain/containment.mjs",
    "scripts/lib/toolchain/provenance.mjs",
    "scripts/ci-workflow.test.mjs",
    "scripts/github-output.test.mjs",
    // The product's own provenance tests: they exercise the shipped reader and
    // verifier against a stub digest fixture, so they depend on nothing the
    // product does not receive.
    "scripts/provenance-source.test.mjs",
    "scripts/wrangler-deploy.mjs",
    "scripts/wrangler-deploy.test.mjs",
    "scripts/wrangler-types.mjs",
    "scripts/wrangler-types.test.mjs",
    "scripts/wrangler-dry-run.mjs",
    "scripts/wrangler-dry-run.test.mjs",
    // The deployment launchers' Cloudflare integration modules. `wrangler-deploy
    // .mjs` and `wrangler-dry-run.mjs` import them for the B5 deployment runtime
    // check, so a product that received the launchers without them could not
    // deploy at all.
    "scripts/lib/cloudflare/deployment-runtime.mjs",
    "scripts/lib/cloudflare/deployment-runtime.test.mjs",
    "scripts/lib/cloudflare/workerd-runtime.mjs",
    "scripts/build-scripts.test.mjs",
    "scripts/deno-no-node.test.mjs",
    "scripts/contracts.verify.test.mjs",
    "scripts/lib/assert.mjs",
    "scripts/lib/command.mjs",
    "scripts/lib/fs.mjs",
    "scripts/lib/os.mjs",
    "scripts/lib/path.mjs",
    "scripts/lib/test.mjs",
    "scripts/lib/toolchain/discovery.mjs",
    "scripts/lib/toolchain/runtime.mjs",
    "scripts/runtime-policy.test.mjs",
    "scripts/contracts/canonical.mjs",
    "scripts/contracts/schema.mjs",
    "scripts/contracts/config.mjs",
    "scripts/contracts/scopes.mjs",
    "scripts/contracts/store.mjs",
    "scripts/contracts/toolchain.mjs",
    "scripts/contracts/identity.mjs",
    // The verifier's identity module reads the declared probe catalogue to
    // fingerprint the workerd-runtime obligations, so the catalogue module
    // travels with it. It declares data and template helpers only.
    "scripts/contracts/fixtures.mjs",
    "scripts/contracts/permissions.mjs",
    "scripts/contracts/verify.mjs",
    "scripts/contracts/cli.mjs",
    "scripts/edge-verify.mjs",
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
  // Release construction — clean tree, annotated tag, tag/commit equality and
  // the generator's own initialisation — is generator-side behaviour. The
  // product ships its own reader/verifier tests instead.
  "scripts/provenance.test.mjs",
  "scripts/toolchain.test.mjs",
  "scripts/generate-product.test.mjs",
  "scripts/contract-refresh.sh",
  "scripts/lib/toolchain/vite.mjs",
  // Toolchain-owned integration, installed with the toolchain: never shipped.
  "toolchain/scripts/vite-runner.mjs",
  "toolchain/scripts/vite-probe.mjs",
  "scripts/contracts/discover.mjs",
  "scripts/contracts/workerd-probe.mjs",
  "scripts/contracts/author-cli.mjs",
  // The generator itself: the product manifest and the generation operation.
  "scripts/product-manifest.mjs",
  "scripts/generate-product.mjs",
  // Toolchain management is generator-only. A product inherits the pinned
  // `.mise.toml` projection and never re-resolves or re-pins the toolchain used
  // to create it, so the authoritative configuration, the resolver and its
  // tests must not travel with it.
  "scripts/toolchain-specify.mjs",
  "scripts/toolchain-specify.test.mjs",
  "scripts/toolchain-invariants.test.mjs",
  // Self-contained validation entry points orchestrate the generator's own
  // installation, initialisation and copy routines, none of which a product
  // ships; a product keeps its inherited `validate` chain instead.
  "scripts/validate-toolchain.mjs",
  "scripts/validate-deployment.mjs",
  "scripts/validate-orchestration.test.mjs",
  "scripts/lib/validation/steps.mjs",
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
