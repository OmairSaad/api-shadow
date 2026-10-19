/**
 * Reads a name-keyed record (imports, exports, classes, ...) without falling through to
 * `Object.prototype`: source code may well name something `constructor` or `toString`.
 */
export function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** A lookup table without a prototype, so `name in table` and `table[name]` see only its entries. */
export function table<T>(entries: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null) as Record<string, T>, entries));
}
