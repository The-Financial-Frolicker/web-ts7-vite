/**
 * Readers for the project configuration a contract is checked against.
 *
 * These are deliberately small: they extract exactly the fields the contract
 * governs (TypeScript `lib` lists and Wrangler's compatibility settings) rather
 * than parsing a whole configuration format. TypeScript configuration files are
 * JSONC in practice, so comments and trailing commas are handled here instead
 * of being silently rejected by `JSON.parse`.
 */

import { readFileSync } from "../lib/fs.mjs";
import path from "../lib/path.mjs";

export const CLIENT_TSCONFIG = "tsconfig.json";
export const WORKER_TSCONFIG = "worker/tsconfig.json";
export const WRANGLER_CONFIG = "wrangler.jsonc";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function fail(message) {
  throw new ConfigError(message);
}

/**
 * Remove JSONC comments and trailing commas, preserving every string literal.
 *
 * The scanner is character-based so a `//` inside a string, an escaped quote or
 * a URL is never mistaken for a comment.
 */
export function stripJsonc(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }

    output += char;
    index += 1;
  }

  // Trailing commas are only removable outside strings; by this point every
  // string that remains is a single-line literal, so a quote-aware pass is
  // still required to avoid touching `",}"` inside a value.
  return dropTrailingCommas(output);
}

function dropTrailingCommas(text) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }

    output += char;
  }

  return output;
}

function readJsonc(root, file, label) {
  let text;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch {
    fail(`cannot read ${label} (${file})`);
  }

  try {
    return JSON.parse(stripJsonc(text));
  } catch (error) {
    fail(`cannot parse ${label} (${file}): ${error.message}`);
  }
}

/** Read the `compilerOptions.lib` list from a JSONC tsconfig. */
export function readLibs(root, file) {
  const config = readJsonc(root, file, "TypeScript configuration");
  const libs = config?.compilerOptions?.lib;
  if (libs === undefined) return [];
  if (!Array.isArray(libs) || libs.some((entry) => typeof entry !== "string")) {
    fail(`${file} compilerOptions.lib must be an array of strings`);
  }

  return libs;
}

/**
 * Read the compatibility settings that apply to the generated Worker.
 *
 * `wrangler.jsonc` is authoritative: it is the source the Vite plugin resolves
 * into `dist/worker/wrangler.json`, and therefore the configuration the runtime
 * probe must reproduce.
 */
export function readWranglerConfig(root) {
  const config = readJsonc(root, WRANGLER_CONFIG, "Wrangler configuration");
  const compatibilityDate = config.compatibility_date;
  const compatibilityFlags = config.compatibility_flags ?? [];

  if (typeof compatibilityDate !== "string" || compatibilityDate.length === 0) {
    fail(`${WRANGLER_CONFIG} must declare compatibility_date`);
  }
  if (
    !Array.isArray(compatibilityFlags) ||
    compatibilityFlags.some((flag) => typeof flag !== "string")
  ) {
    fail(`${WRANGLER_CONFIG} compatibility_flags must be an array of strings`);
  }

  return { compatibilityDate, compatibilityFlags, file: WRANGLER_CONFIG };
}
