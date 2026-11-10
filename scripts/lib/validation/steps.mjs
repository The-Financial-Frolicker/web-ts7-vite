/**
 * Sequential execution of the operations a validation entry point orchestrates.
 *
 * A plan is an ordered list of commands the repository already provides. This
 * module only runs them in order, stops at the first failure and lets the caller
 * clean up; it is not a workflow engine (no dependency graph, no retries, no
 * plugin surface). Tests inject `run`, so a plan can be asserted without
 * installing, building or deploying anything.
 */

/** A step finished with a non-zero exit status. */
export class ValidationStepError extends Error {
  constructor(step, code) {
    super(`${step.name} failed with exit code ${code}`);
    this.name = "ValidationStepError";
    this.step = step;
    this.code = code;
  }
}

/**
 * Run one step through `run`, echoing what it wrote.
 *
 * `run` receives `{ command, args, cwd, env }` and returns `{ code, stdout }`.
 */
export function executeStep(step, { run = runCommand, io = console } = {}) {
  io.log(`==> ${step.name}`);
  const result = run(step);
  if (result.code !== 0) throw new ValidationStepError(step, result.code);
  return result;
}

/** Run every step in order; the first failure stops the plan. */
export function executePlan(steps, options = {}) {
  let last;
  for (const step of steps) last = executeStep(step, options);
  return last;
}

/**
 * Default runner: capture both streams, echo them, and report the exit status.
 *
 * Output is captured rather than inherited so a step can both show its log and
 * return a machine-readable marker to the orchestrator.
 */
export function runCommand(step, io = console) {
  const result = new Deno.Command(step.command, {
    args: step.args ?? [],
    cwd: step.cwd,
    env: step.env,
    stdin: "inherit",
    stdout: "piped",
    stderr: "piped",
  }).outputSync();

  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (stdout.length > 0) io.log(stdout.trimEnd());
  if (stderr.length > 0) io.error(stderr.trimEnd());

  return { code: result.code, stdout, stderr };
}
