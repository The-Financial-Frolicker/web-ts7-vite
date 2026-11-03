/** Small assertion surface used by the Deno-native test suites. */

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

function format(value) {
  return Deno.inspect(value, { colors: false, depth: 5 });
}

function fail(message) {
  throw new AssertionError(message);
}

function deepEqual(left, right, seen = new Set()) {
  if (Object.is(left, right)) return true;
  if (
    left === null || right === null || typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  if (left.constructor !== right.constructor) return false;

  const pair = `${left}\0${right}`;
  if (seen.has(pair)) return true;

  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) =>
      deepEqual(value, right[index], new Set([...seen, pair]))
    );
  }

  if (left instanceof Date) return left.getTime() === right.getTime();
  if (left instanceof RegExp) return String(left) === String(right);

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every((key, index) =>
    key === rightKeys[index] &&
    deepEqual(left[key], right[key], new Set([...seen, pair]))
  );
}

/** Assert a truthy value. */
export function assert(value, message = "expected a truthy value") {
  if (!value) fail(message);
}

assert.ok = assert;

assert.equal = (actual, expected, message) => {
  if (!Object.is(actual, expected)) {
    fail(
      message ??
        `expected ${format(expected)}, received ${format(actual)}`,
    );
  }
};

assert.deepEqual = (actual, expected, message) => {
  if (!deepEqual(actual, expected)) {
    fail(
      message ??
        `expected ${format(expected)}, received ${format(actual)}`,
    );
  }
};

assert.match = (value, pattern, message) => {
  pattern.lastIndex = 0;
  if (!pattern.test(String(value))) {
    fail(message ?? `expected ${format(value)} to match ${pattern}`);
  }
};

assert.doesNotMatch = (value, pattern, message) => {
  pattern.lastIndex = 0;
  if (pattern.test(String(value))) {
    fail(message ?? `expected ${format(value)} not to match ${pattern}`);
  }
};

assert.throws = (fn, expected, message) => {
  let error;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }

  if (error === undefined) {
    fail(message ?? "expected the function to throw");
  }

  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    if (!expected.test(String(error?.message ?? error))) {
      fail(
        message ??
          `expected thrown message ${
            format(error?.message)
          } to match ${expected}`,
      );
    }
  } else if (typeof expected === "function") {
    if (
      expected.prototype instanceof Error &&
      !(error instanceof expected)
    ) {
      fail(
        message ?? `expected ${expected.name}, received ${format(error)}`,
      );
    }

    if (!(expected.prototype instanceof Error)) {
      const accepted = expected(error);
      if (!accepted) fail(message ?? "thrown error did not satisfy validator");
    }
  }

  return error;
};

export default assert;
