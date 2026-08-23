import { describe, expect, it } from 'vitest'
import {
  createSafeRecord,
  deleteSafeRecordValue,
  getSafeRecordValue,
  isSafeRecordKey,
  setSafeRecordValue,
} from '@/services/safeRecord'

describe('safe dynamic records', () => {
  it('rejects prototype control keys', () => {
    expect(isSafeRecordKey('project-1')).toBe(true)
    expect(isSafeRecordKey('__proto__')).toBe(false)
    expect(isSafeRecordKey('constructor')).toBe(false)
    expect(isSafeRecordKey('prototype')).toBe(false)
  })

  it('stores ordinary keys without inheriting an object prototype', () => {
    const record = createSafeRecord<number>()
    setSafeRecordValue(record, 'project-1', 42)

    expect(Object.getPrototypeOf(record)).toBeNull()
    expect(getSafeRecordValue(record, 'project-1')).toBe(42)
    expect(deleteSafeRecordValue(record, 'project-1')).toBe(true)
    expect(getSafeRecordValue(record, 'project-1')).toBeUndefined()
  })

  it('fails closed instead of mutating the prototype', () => {
    const record = createSafeRecord<unknown>()

    expect(() => setSafeRecordValue(record, '__proto__', { polluted: true })).toThrow(/unsafe/i)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})
