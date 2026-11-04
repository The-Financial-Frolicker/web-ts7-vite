/**
 * Toolchain configuration: parsing, validation and projection.
 *
 * `toolchain.toml` is the single source of desired tool versions. `.mise.toml`
 * is generated from it, so there is never a second editable version list.
 *
 * The parser is a deliberately small TOML subset — one `[tools]` table of
 * `name = "version"` pairs — because that is all the contract needs. Unknown
 * sections, unknown value types and duplicate keys are errors rather than being
 * ignored, so a malformed file cannot silently lose a pin.
 */

export const LATEST = "latest";

/** Tools this template manages through mise, in a stable order. */
export const SUPPORTED_TOOLS = Object.freeze([
  "deno",
  "cmake",
  "ninja",
  "emsdk",
]);

export class ToolchainConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ToolchainConfigError";
  }
}

function fail(message) {
  throw new ToolchainConfigError(message);
}

/** Remove a trailing `#` comment that is outside a double-quoted string. */
function stripComment(line) {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && inString) {
      index += 1;
      continue;
    }
    if (char === '"') inString = !inString;
    if (char === "#" && !inString) return line.slice(0, index);
  }
  return line;
}

/**
 * Parse the configuration text.
 *
 * Returns `{ "<tool>": "<requested>" }` where `requested` is the literal value
 * from the file (`"latest"` or an exact version). Omission handling happens in
 * `normaliseConfig`, so this function reports exactly what was written.
 */
export function parseToolchainConfig(text) {
  const tools = {};
  let section = null;

  for (const [offset, rawLine] of text.split("\n").entries()) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;

    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header !== null) {
      if (header[1] !== "tools") {
        fail(
          `line ${offset + 1}: unsupported section [${header[1]}]; ` +
            `only [tools] is recognised`,
        );
      }
      section = header[1];
      continue;
    }

    if (section === null) {
      fail(`line ${offset + 1}: expected a [tools] section header first`);
    }

    const entry = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"$/.exec(line);
    if (entry === null) {
      fail(
        `line ${offset + 1}: expected \`name = "version"\`, received ` +
          `${JSON.stringify(rawLine.trim())}`,
      );
    }

    const [, name, version] = entry;
    if (Object.hasOwn(tools, name)) {
      fail(
        `line ${offset + 1}: duplicate entry for tool ${JSON.stringify(name)}`,
      );
    }
    tools[name] = version;
  }

  if (section === null) fail("no [tools] section found");
  return tools;
}

const EXACT_VERSION = /^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/;

/** True when `value` is either `latest` or a syntactically valid version. */
export function isValidVersionDeclaration(value) {
  return value === LATEST || EXACT_VERSION.test(value);
}

/**
 * Validate the parsed configuration and return normalised entries.
 *
 * Each entry is `{ tool, requested, source }` where `source` is `"explicit"`,
 * `"latest"` or `"omitted"`. Entries appear in `SUPPORTED_TOOLS` order so
 * reporting and installation are deterministic.
 */
export function normaliseConfig(tools) {
  for (const name of Object.keys(tools)) {
    if (!SUPPORTED_TOOLS.includes(name)) {
      fail(
        `unsupported tool ${JSON.stringify(name)}; this generator manages ` +
          `${SUPPORTED_TOOLS.join(", ")}`,
      );
    }
  }

  return SUPPORTED_TOOLS.map((tool) => {
    if (!Object.hasOwn(tools, tool)) {
      return { tool, requested: LATEST, source: "omitted" };
    }

    const value = tools[tool];
    if (!isValidVersionDeclaration(value)) {
      fail(
        `invalid version ${JSON.stringify(value)} for ${tool}; expected an ` +
          `exact version such as "1.2.3" or "latest"`,
      );
    }

    return {
      tool,
      requested: value,
      source: value === LATEST ? "latest" : "explicit",
    };
  });
}

/** Parse and validate in one step. */
export function loadToolchainConfig(text) {
  return normaliseConfig(parseToolchainConfig(text));
}

/** Parse the version list printed by `mise ls-remote <tool>`. */
export function parseAvailableVersions(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => EXACT_VERSION.test(line));
}

function compareVersions(left, right) {
  const leftParts = left.split(/[-+]/)[0].split(".").map(Number);
  const rightParts = right.split(/[-+]/)[0].split(".").map(Number);

  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) return a - b;
  }

  return left.localeCompare(right);
}

/** Highest available version, or `null` for an empty list. */
export function newestVersion(versions) {
  if (versions.length === 0) return null;
  return [...versions].sort(compareVersions).at(-1);
}

/**
 * Notes that belong to the projection itself.
 *
 * `.mise.toml` is a generated artefact, so its maintained commentary belongs
 * here rather than in the file: a `--write` that dropped it would silently lose
 * the project's policy on host-provided tools. Version-specific annotations
 * (for example why a particular cmake release is pinned) stay in
 * `toolchain.toml`, next to the version they explain.
 */
export const PROJECTION_NOTES = Object.freeze([
  "# Python is NOT project-managed. Emscripten needs the host's python3 (>= 3.10);",
  "# scripts/resolve-python.sh uses it when present and only provisions a fallback",
  "# at the requirement the installed SDK reports when the host cannot satisfy it.",
  "# Node.js is intentionally not project-managed. Emscripten ships its own Node;",
  "# real deployment and Vite dev/preview may use a host-provided Node.",
]);

/**
 * Render the `.mise.toml` projection.
 *
 * Only exact versions may be projected: a `latest` request must be resolved
 * first, so mise never receives an unresolved selection that it could interpret
 * differently later.
 */
export function projectMiseToml(resolution) {
  const lines = [
    "# Generated from toolchain.toml by `deno task toolchain:prepare`.",
    "# Edit toolchain.toml instead; this file is a projection.",
    "",
    "[tools]",
  ];

  for (const entry of resolution) {
    if (entry.resolved === null) {
      fail(
        `cannot project ${entry.tool}: version ${
          JSON.stringify(entry.requested)
        } ` +
          `has not been resolved`,
      );
    }
    lines.push(`${entry.tool} = "${entry.resolved}"`);
  }

  lines.push("", ...PROJECTION_NOTES);

  return `${lines.join("\n")}\n`;
}
