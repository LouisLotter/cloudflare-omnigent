/** `value`, or a test failure naming what was missing. Instead of a non-null assertion. */
export function defined<T>(value: T | null | undefined, what = "a value"): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/** The differences between consecutive numbers. */
export function gaps(values: readonly number[]): number[] {
  return values.slice(1).map((value, i) => value - (values[i] ?? Number.NaN));
}
