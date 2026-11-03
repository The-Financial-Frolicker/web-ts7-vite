/** Run a subprocess through `Deno.Command` and return its exit status/text. */

const decoder = new TextDecoder();

/**
 * Run a command synchronously. Environment replacement is explicit: callers
 * that intend to replace the environment pass `clearEnv: true` together with a
 * complete `env` object.
 */
export function run(command, options = {}) {
  const output = new Deno.Command(command, {
    args: options.args ?? [],
    cwd: options.cwd,
    env: options.env,
    clearEnv: options.clearEnv === true,
    stdin: options.stdin ?? "null",
    stdout: options.stdout ?? "piped",
    stderr: options.stderr ?? "piped",
  }).outputSync();

  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

/** Run a command and throw with its stderr when it exits non-zero. */
export function runChecked(command, options = {}) {
  const result = run(command, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${options.args?.join(" ") ?? ""} exited with ` +
        `${result.code}: ${result.stderr.trim()}`,
    );
  }

  return result;
}
