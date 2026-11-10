/**
 * Tests for `deployment:install` — the deployment dependency closure.
 *
 * Fixtures are synthetic trees, so the assertions are about the installer's
 * decisions (which paths, which packages, which checks) and not about today's
 * installed versions. The real installation is exercised by running the task.
 *
 * The properties this file is responsible for:
 *   * the deployment tree is a contained sibling of the toolchain tree, and is
 *     never the toolchain tree itself;
 *   * the specification must be exactly the deployment closure, pinned;
 *   * a staged tree that cannot satisfy B5 is refused;
 *   * a build-only package in the closure is refused;
 *   * the record is read from the deployment tree by name, not by directory.
 */
import assert from "./lib/assert.mjs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "./lib/fs.mjs";
import os from "./lib/os.mjs";
import path from "./lib/path.mjs";
import { after, describe, it } from "./lib/test.mjs";
import {
  assertDeclaredClosure,
  planInstallation,
  REQUIRED_PACKAGES,
  validateStaging,
} from "./deployment-install.mjs";
import {
  DEPLOYMENT_RECORD,
  deploymentInstallationRootPath,
  installedIdentity,
  TOOLCHAIN_RECORD,
} from "./lib/toolchain/runtime.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix = "deployment-install-") {
  const root = Deno.realPathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  // The resolver requires a real project root with a pin file.
  writeFileSync(
    path.join(root, ".mise.toml"),
    `[tools]\ndeno = "${Deno.version.deno}"\n`,
  );
  return root;
}

function write(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function platformPackage() {
  const osName = { win32: "windows" }[Deno.build.os] ?? Deno.build.os;
  const arch = { x86_64: "64", aarch64: "arm64", arm: "arm", ia32: "ia32" }[
    Deno.build.arch
  ] ?? Deno.build.arch;
  return `@cloudflare/workerd-${osName}-${arch}`;
}

/**
 * A staged tree that satisfies the deployment closure: Wrangler, the Cloudflare
 * Vite plugin, and one shared Miniflare/workerd graph.
 */
function stagedTree(
  { plugin = true, typescript = false, miniflare = true } = {},
) {
  const staging = tempRoot("deployment-staging-");
  const store = (name, version) =>
    `node_modules/.deno/${
      name.replaceAll("/", "+")
    }@${version}/node_modules/${name}`;

  const writePackage = (name, version, extra = {}) =>
    write(
      staging,
      `${store(name, version)}/package.json`,
      JSON.stringify({ name, version, ...extra }),
    );

  writePackage("wrangler", "4.156.0", {
    main: "wrangler-dist/cli.js",
    dependencies: { miniflare: "5.0.0" },
  });
  write(staging, `${store("wrangler", "4.156.0")}/wrangler-dist/cli.js`, "");
  if (plugin) {
    writePackage("@cloudflare/vite-plugin", "1.66.0", {
      dependencies: { miniflare: "5.0.0" },
    });
  }
  if (miniflare) {
    writePackage("miniflare", "5.0.0", { dependencies: { workerd: "1.0.0" } });
    writePackage("workerd", "1.0.0", {
      optionalDependencies: { [platformPackage()]: "1.0.0" },
    });
    writePackage(platformPackage(), "1.0.0");
    write(
      staging,
      `${store(platformPackage(), "1.0.0")}/bin/workerd`,
      "#!/bin/sh\n",
    );
  }
  if (typescript) {
    writePackage("typescript", "7.0.2");
  }

  return staging;
}

describe("deployment installation planning", () => {
  it("installs beside the toolchain tree, never into it", () => {
    const root = tempRoot();
    const plan = planInstallation({ projectRoot: root, env: new Map() });

    assert.equal(plan.target, path.join(root, "generator", "deployment"));
    assert.equal(
      plan.toolchainRoot,
      path.join(root, "generator", "toolchain"),
    );
    assert.ok(plan.target !== plan.toolchainRoot);
    assert.ok(plan.staging.startsWith(path.join(root, "generator", ".")));
    assert.ok(plan.previous.startsWith(path.join(root, "generator", ".")));
    assert.ok(plan.staging !== plan.target);
    assert.ok(plan.previous !== plan.target);
    // Siblings, not ancestors: the swap must stay on one filesystem.
    assert.equal(path.dirname(plan.target), path.dirname(plan.staging));
  });

  it("refuses an override outside the generator-owned subroot", () => {
    const root = tempRoot();
    const env = new Map([["DEPLOYMENT_ROOT", path.join(root, "vendor")]]);
    assert.throws(
      () => planInstallation({ projectRoot: root, env }),
      /outside the generator-owned subroot/,
    );
  });

  it("refuses an override that would land on the toolchain tree", () => {
    const root = tempRoot();
    const env = new Map([[
      "DEPLOYMENT_ROOT",
      path.join(root, "generator", "toolchain"),
    ]]);
    assert.throws(
      () => planInstallation({ projectRoot: root, env }),
      /must never be the toolchain installation/,
    );
  });

  it("refuses the application-owned subtree", () => {
    const root = tempRoot();
    const env = new Map([[
      "DEPLOYMENT_ROOT",
      path.join(root, "application", "deps"),
    ]]);
    assert.throws(
      () => planInstallation({ projectRoot: root, env }),
      /application-owned root/,
    );
  });

  it("is pure: planning creates nothing", () => {
    const root = tempRoot();
    planInstallation({ projectRoot: root, env: new Map() });
    let created = true;
    try {
      Deno.statSync(path.join(root, "generator"));
    } catch {
      created = false;
    }
    assert.equal(created, false, "planning must not create the subroot");
  });
});

describe("deployment closure specification", () => {
  it("accepts exactly the deployment packages, pinned", () => {
    assert.deepEqual(
      Object.keys(
        assertDeclaredClosure({
          wrangler: "4.156.0",
          "@cloudflare/vite-plugin": "1.66.0",
        }),
      ).sort(),
      [...REQUIRED_PACKAGES].sort(),
    );
  });

  it("rejects a build-only package in the specification", () => {
    assert.throws(
      () =>
        assertDeclaredClosure({
          wrangler: "4.156.0",
          "@cloudflare/vite-plugin": "1.66.0",
          vite: "8.3.5",
        }),
      /the deployment closure is exactly/,
    );
  });

  it("rejects a missing deployment package", () => {
    assert.throws(
      () => assertDeclaredClosure({ wrangler: "4.156.0" }),
      /the deployment closure is exactly/,
    );
  });

  it("rejects a loose version range", () => {
    assert.throws(
      () =>
        assertDeclaredClosure({
          wrangler: "^4.156.0",
          "@cloudflare/vite-plugin": "1.66.0",
        }),
      /specified exactly/,
    );
  });
});

describe("staged deployment closure validation", () => {
  it("accepts a closure whose two graphs agree", () => {
    const staging = stagedTree();
    const result = validateStaging(staging);

    assert.deepEqual(result.installed, {
      wrangler: "4.156.0",
      "@cloudflare/vite-plugin": "1.66.0",
    });
    assert.equal(result.runtime.workerdVersion, "1.0.0");
    assert.ok(result.runtime.binary.startsWith(staging));
  });

  it("refuses a closure that is missing a deployment package", () => {
    const staging = stagedTree({ plugin: false });
    assert.throws(
      () => validateStaging(staging),
      /@cloudflare\/vite-plugin is missing from the deployment closure/,
    );
  });

  it("refuses a closure whose runtime graph cannot be resolved", () => {
    // Every required package is present, but Wrangler's declared Miniflare is
    // missing, so the graph B5 walks cannot resolve.
    const staging = stagedTree({ miniflare: false });
    assert.throws(
      () => validateStaging(staging),
      /dependency graph could not be resolved/,
    );
  });

  it("refuses a closure carrying a build-only package", () => {
    const staging = stagedTree({ typescript: true });
    assert.throws(
      () => validateStaging(staging),
      /typescript .* is installed in the deployment closure/,
    );
  });

  it("refuses a closure without the Wrangler CLI the launchers run", () => {
    const staging = stagedTree();
    rmSync(
      path.join(
        staging,
        "node_modules/.deno/wrangler@4.156.0/node_modules/wrangler/wrangler-dist/cli.js",
      ),
    );
    assert.throws(
      () => validateStaging(staging),
      /staged deployment closure is incomplete/,
    );
  });
});

describe("deployment installation record", () => {
  it("is read from the deployment tree by name", () => {
    const install = tempRoot("deployment-record-");
    writeFileSync(
      path.join(install, DEPLOYMENT_RECORD),
      `${JSON.stringify({ schema: 1, role: "deployment", deno: "x" })}\n`,
    );

    assert.equal(
      installedIdentity(install, DEPLOYMENT_RECORD).role,
      "deployment",
    );
    // The toolchain record is a different file in a different tree.
    assert.equal(DEPLOYMENT_RECORD === TOOLCHAIN_RECORD, false);
    assert.throws(
      () => installedIdentity(install, TOOLCHAIN_RECORD),
      /is not a complete generator installation/,
    );
  });

  it("names the operation that provisions it", () => {
    const install = tempRoot("deployment-record-hint-");
    assert.throws(
      () => installedIdentity(install, DEPLOYMENT_RECORD),
      /re-run `deno task deployment:install`/,
    );
  });

  it("resolves the deployment root inside the generator subroot", () => {
    const root = tempRoot("deployment-root-");
    assert.equal(
      deploymentInstallationRootPath(root, new Map()),
      path.join(root, "generator", "deployment"),
    );
  });

  it("ships a specification that matches the required closure", () => {
    // The committed specification is the closure the installer validates
    // against, so a drift between them is a defect rather than a style choice.
    const spec = JSON.parse(
      readFileSync(
        path.join(Deno.cwd(), "deployment", "package.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      Object.keys(spec.dependencies).sort(),
      [...REQUIRED_PACKAGES].sort(),
    );
  });
});
