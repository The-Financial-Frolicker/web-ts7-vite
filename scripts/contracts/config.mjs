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
export const VITE_CONFIG = "vite.config.ts";

/** Vite's own symbolic default for a production build target. */
export const DEFAULT_VITE_BUILD_TARGET = "baseline-widely-available";

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

/**
 * Read the production `build.target` the authorised Vite configuration declares.
 *
 * Verification runs read-only and must not execute Vite, so the override has to
 * be legible from the source. This reader recognises exactly one literal form —
 * `target: "…"` or `target: ["…", …]` — and fails closed on anything else: two
 * declarations, a non-literal expression or a malformed array are errors rather
 * than a guess. Absence means the project takes Vite's own symbolic default,
 * which is recorded as such instead of being duplicated as a browser table.
 */
export function readViteBuildTarget(root) {
  let text;
  try {
    text = readFileSync(path.join(root, VITE_CONFIG), "utf8");
  } catch {
    fail(`cannot read Vite configuration (${VITE_CONFIG})`);
  }

  const declarations = findTargetDeclarations(stripJsonc(text));
  if (declarations.length === 0) return DEFAULT_VITE_BUILD_TARGET;
  if (declarations.length > 1) {
    fail(
      `${VITE_CONFIG} declares build.target more than once; the contract ` +
        `reader requires a single literal declaration`,
    );
  }

  return declarations[0];
}

/**
 * Find `target: <literal>` declarations outside comments and strings.
 *
 * A token scan rather than a parser: the value must be a literal so the reader
 * can never silently accept an expression it does not understand.
 */
function findTargetDeclarations(text) {
  const found = [];
  const isWordChar = (char) => char !== undefined && /[A-Za-z0-9_$]/.test(char);

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index);
      continue;
    }

    if (text.startsWith("target", index) && !isWordChar(text[index - 1])) {
      let cursor = index + "target".length;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] !== ":") continue;

      const parsed = parseTargetLiteral(text, cursor + 1);
      found.push(parsed.value);
      index = parsed.end;
    }
  }

  return found;
}

/** Parse the literal that follows `target:`; fail closed on anything else. */
function parseTargetLiteral(text, start) {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;

  if (text[cursor] === '"' || text[cursor] === "'") {
    const parsed = readStringLiteral(text, cursor);
    return { value: parsed.value, end: parsed.end };
  }

  if (text[cursor] === "[") {
    const values = [];
    cursor += 1;
    for (;;) {
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] === "]") return { value: values, end: cursor + 1 };
      if (text[cursor] !== '"' && text[cursor] !== "'") break;
      const parsed = readStringLiteral(text, cursor);
      values.push(parsed.value);
      cursor = parsed.end;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (text[cursor] === ",") cursor += 1;
      else if (text[cursor] !== "]") break;
    }
  }

  return fail(
    `${VITE_CONFIG} build.target must be a string literal or an array of ` +
      `string literals so it can be recorded deterministically`,
  );
}

/** Read one quoted string literal starting at `start` (which is the quote). */
function readStringLiteral(text, start) {
  const quote = text[start];
  let value = "";
  let cursor = start + 1;

  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "\\") {
      value += text[cursor + 1] ?? "";
      cursor += 2;
      continue;
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char;
    cursor += 1;
  }

  return fail(`${VITE_CONFIG} has an unterminated string literal`);
}

/** Skip a quoted string starting at `start`; returns the index after its end. */
function skipString(text, start) {
  const quote = text[start];
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text[cursor] === quote) return cursor + 1;
    cursor += 1;
  }
  return text.length;
}
