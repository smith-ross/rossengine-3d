// Script tables are Maps in the engine. A list is a Map keyed 1..n, but an empty Map could be an
// empty list or an empty dictionary: lists that started as arrays carry a marker, so `[]` stays a
// list (in Python/TypeScript, and in save files) instead of turning into `{}`.
const LIST = Symbol.for('rossengine.list')

/** A Map for a script list (marked, so it stays a list even when empty). */
export function listMap(items: unknown[] = []): Map<unknown, unknown> {
  const m = new Map<unknown, unknown>(items.map((x, i) => [i + 1, x]))
  ;(m as unknown as Record<symbol, boolean>)[LIST] = true
  return m
}

/** Should this table be a list (array) rather than a dictionary? */
export function isListMap(m: Map<unknown, unknown>): boolean {
  if (m.size === 0) return !!(m as unknown as Record<symbol, boolean>)[LIST]
  let i = 1
  for (const k of m.keys()) if (k !== i++) return false
  return true
}
