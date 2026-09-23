const missing = Symbol('missing')
type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

/** Arrays and deletions are atomic; ambiguous or oversized changes require a human decision. */
export function safeDisjointMetadataMerge(base: unknown, local: unknown, remote: unknown): JsonObject | null {
  let nodes = 0
  const canonical = (value: unknown, depth = 0): unknown => {
    if (++nodes > 4000 || depth > 16) throw new Error('metadata_merge_budget')
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1))
    if (!object(value)) throw new Error('metadata_merge_value')
    const result: JsonObject = {}
    for (const key of Object.keys(value).sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('metadata_merge_key')
      Reflect.set(result, key, canonical(Reflect.get(value, key), depth + 1))
    }
    return result
  }
  const equal = (left: unknown, right: unknown) =>
    left === missing || right === missing ? left === right : JSON.stringify(left) === JSON.stringify(right)
  const merge = (original: unknown, mine: unknown, theirs: unknown): unknown => {
    if (equal(mine, theirs)) return mine
    if (equal(mine, original)) return theirs
    if (equal(theirs, original)) return mine
    if (!object(original) || !object(mine) || !object(theirs)) throw new Error('metadata_merge_conflict')
    const result: JsonObject = {}
    for (const key of new Set([...Object.keys(original), ...Object.keys(mine), ...Object.keys(theirs)])) {
      const value = merge(
        Object.hasOwn(original, key) ? Reflect.get(original, key) : missing,
        Object.hasOwn(mine, key) ? Reflect.get(mine, key) : missing,
        Object.hasOwn(theirs, key) ? Reflect.get(theirs, key) : missing
      )
      if (value !== missing) Reflect.set(result, key, value)
    }
    return result
  }
  try {
    const original = canonical(base)
    const mine = canonical(local)
    const theirs = canonical(remote)
    if (!object(original) || !object(mine) || !object(theirs)) return null
    if (JSON.stringify([original, mine, theirs]).length > 128_000) return null
    // An explicit value remains protected even when its scalar did not change from base.
    const overridden = new Set([
      ...(Array.isArray(mine.overrides) ? mine.overrides : []),
      ...(Array.isArray(theirs.overrides) ? theirs.overrides : []),
    ])
    for (const field of overridden)
      if (
        typeof field === 'string' &&
        Object.hasOwn(mine, field) &&
        Object.hasOwn(theirs, field) &&
        !equal(Reflect.get(mine, field), Reflect.get(theirs, field))
      )
        return null
    const result = merge(original, mine, theirs)
    return object(result) ? structuredClone(result) : null
  } catch {
    return null
  }
}
