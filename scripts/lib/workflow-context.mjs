/**
 * Which checkout a workflow step executes in.
 *
 * Ownership cannot be inferred from shell history: a `cd` inside a `run:` block
 * is ordinary shell text, and a step that merely mentions a directory is not
 * thereby authorised to run a generator-only task. GitHub Actions expresses this
 * explicitly with `working-directory`, so that is the only evidence accepted
 * here. A step with no `working-directory` runs in the checkout root — for a
 * generated product, the product itself.
 */

/** The declared working directory, or null when the step declares none. */
export function stepWorkingDirectory(bodyLines) {
  for (const line of bodyLines) {
    const match = /^\s*working-directory:\s*(.+?)\s*$/.exec(line);
    if (match !== null) return match[1];
  }
  return null;
}

/**
 * True only when the step *declares* that it runs in the generator checkout.
 *
 * `${{ runner.temp }}/generator` qualifies; the product workspace does not, and
 * neither does any path that only appears inside a `run:` block.
 */
export function runsInGeneratorCheckout(bodyLines) {
  const directory = stepWorkingDirectory(bodyLines);
  if (directory === null) return false;
  if (/github\.workspace/.test(directory)) return false;
  return /(^|\/)generator\/?$/.test(directory.replace(/^["']|["']$/g, ""));
}
