/**
 * Resolve and install the configured toolchain.
 *
 *   deno task toolchain:prepare            resolve, install, verify, record
 *   deno task toolchain:prepare --check    resolve, verify installed + projection
 *   deno task toolchain:prepare --dry-run  resolve only (no installation)
 *
 * The configuration file (`toolchain.toml`) is authoritative. `.mise.toml` is a
 * projection of the resolved versions; `--write` regenerates it.
 */

import { readFileSync } from "./lib/fs.mjs";
import path from "./lib/path.mjs";
import {
  loadToolchainConfig,
  parseToolchainConfig,
  projectMiseToml,
  ToolchainConfigError,
} from "./lib/toolchain/versions.mjs";
import {
  createMiseRunner,
  describeProvenance,
  installToolchain,
  resolveToolchain,
  verifyInstalled,
} from "./lib/toolchain/resolve.mjs";

export const CONFIG_FILE = "toolchain.toml";
export const MISE_FILE = ".mise.toml";
export const PROVENANCE_FILE = path.join(
  ".contracts",
  "toolchain-provenance.json",
);

export function main(
  argv = Deno.args,
  root = Deno.cwd(),
  io = console,
  run = createMiseRunner(),
) {
  const dryRun = argv.includes("--dry-run");
  const check = argv.includes("--check");
  const write = argv.includes("--write");

  try {
    const entries = loadToolchainConfig(
      readFileSync(path.join(root, CONFIG_FILE), "utf8"),
    );
    io.log(
      `[toolchain] ${CONFIG_FILE}: ${entries.length} tool(s) ` +
        `(${
          entries.map((entry) => `${entry.tool}=${entry.requested}`).join(", ")
        })`,
    );

    // Every version is resolved before anything is installed.
    const resolution = resolveToolchain({ entries, run });
    for (const entry of resolution) {
      io.log(
        `[toolchain] ${entry.tool}: ${entry.requested} -> ${entry.resolved}`,
      );
    }

    if (dryRun) {
      io.log("[toolchain] dry run: nothing installed");
      return 0;
    }

    let installed = resolution;
    if (!check) {
      installToolchain({ resolution, run, io });
      installed = verifyInstalled({ resolution, run });
      io.log("[toolchain] installed versions match the resolved versions");
    } else {
      installed = verifyInstalled({ resolution, run });
    }

    const projection = projectMiseToml(installed);
    const current = readFileSync(path.join(root, MISE_FILE), "utf8");

    if (current !== projection && !write) {
      io.error(
        `[toolchain] ${MISE_FILE} is not the projection of the resolved ` +
          `toolchain. Run \`deno task toolchain:prepare --write\` and review ` +
          `the diff; version-specific notes belong in ${CONFIG_FILE}.`,
      );
      const currentPins = parseToolchainConfig(current);
      for (const entry of installed) {
        if (currentPins[entry.tool] !== entry.resolved) {
          io.error(
            `[toolchain] ${entry.tool}: ${MISE_FILE} pins ` +
              `${
                currentPins[entry.tool] ?? "absent"
              }, resolved ${entry.resolved}`,
          );
        }
      }
      return 2;
    }

    if (write) {
      Deno.writeTextFileSync(path.join(root, MISE_FILE), projection);
      io.log(`[toolchain] wrote ${MISE_FILE} from the resolved toolchain`);
    }

    const provenance = describeProvenance(installed);
    Deno.mkdirSync(path.dirname(path.join(root, PROVENANCE_FILE)), {
      recursive: true,
    });
    Deno.writeTextFileSync(
      path.join(root, PROVENANCE_FILE),
      `${JSON.stringify({ tools: provenance }, null, 2)}\n`,
    );
    for (const entry of provenance) {
      io.log(
        `[toolchain] ${entry.tool}: requested ${entry.requested} ` +
          `(${entry.requestSource}), resolved ${entry.resolved}, ` +
          `installed ${entry.installed}`,
      );
    }

    return 0;
  } catch (error) {
    if (error instanceof ToolchainConfigError) {
      io.error(`Error: ${error.message}`);
      return 1;
    }
    if (error instanceof Deno.errors.NotFound) {
      io.error(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  Deno.exitCode = main();
}
