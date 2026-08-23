const RESERVED_RECORD_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function isSafeRecordKey(key: string): boolean {
  return key.length > 0 && key.length <= 200 && !RESERVED_RECORD_KEYS.has(key)
}

export function createSafeRecord<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>
}

export function getSafeRecordValue<Value>(record: Record<string, Value>, key: string): Value | undefined {
  if (!isSafeRecordKey(key) || !Object.prototype.hasOwnProperty.call(record, key)) return undefined
  return Reflect.get(record, key) as Value | undefined
}

export function setSafeRecordValue<Value>(record: Record<string, Value>, key: string, value: Value): void {
  if (!isSafeRecordKey(key)) throw new Error('Unsafe record key rejected.')
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

export function deleteSafeRecordValue<Value>(record: Record<string, Value>, key: string): boolean {
  if (!isSafeRecordKey(key)) return false
  return Reflect.deleteProperty(record, key)
}
