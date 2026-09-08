import { describe, expect, it } from 'vitest'
import { workflowTimeToUtc, workflowZonedTime } from '@/services/workflows/timezone'

describe('workflow wall-clock scheduling', () => {
  it('converts a selected IANA timezone independent from the device zone', () => {
    expect(workflowTimeToUtc('2026-09-08T09:00', 'America/New_York')).toBe('2026-09-08T13:00:00.000Z')
    expect(workflowZonedTime('2026-09-08T13:00:00.000Z', 'Asia/Kolkata')).toBe('2026-09-08T18:30')
  })
  it('selects the first repeated fall minute exactly once', () => {
    expect(workflowTimeToUtc('2026-10-25T02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z')
  })
  it('rejects the missing spring minute rather than silently shifting the time', () => {
    expect(() => workflowTimeToUtc('2026-03-29T02:30', 'Europe/Berlin')).toThrow('existiert')
  })
  it('rejects impossible dates and unknown zones', () => {
    expect(() => workflowTimeToUtc('2026-02-30T12:00', 'UTC')).toThrow()
    expect(() => workflowTimeToUtc('2026-09-08T09:00', 'Nowhere/Invalid')).toThrow()
  })
})
