const RESERVED_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function isSafeRecordKey(key: string): boolean {
  return key.length > 0 && key.length <= 200 && !RESERVED_RECORD_KEYS.has(key)
}

export function createSafeRecord<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>
}

export function getSafeRecordValue<Value>(record: Record<string, Value>, key: string): Value | undefined {
  if (!isSafeRecordKey(key)) return undefined
  // Read through the proxy first so a reactive record tracks this key even while it is absent;
  // hasOwnProperty alone bypasses the proxy and readers would never learn about a later write.
  const value = Reflect.get(record, key) as Value | undefined
  return Object.prototype.hasOwnProperty.call(record, key) ? value : undefined
}

export function setSafeRecordValue<Value>(record: Record<string, Value>, key: string, value: Value): void {
  if (!isSafeRecordKey(key)) throw new Error('Unsafe record key rejected.')
  // Reflect.set goes through a reactive proxy's `set` trap. Object.defineProperty bypassed it,
  // so e.g. the selected chat per project changed on disk but no computed ever re-evaluated.
  if (!Reflect.set(record, key, value)) throw new Error('Record value could not be written.')
}

export function deleteSafeRecordValue<Value>(record: Record<string, Value>, key: string): boolean {
  if (!isSafeRecordKey(key)) return false
  return Reflect.deleteProperty(record, key)
}
