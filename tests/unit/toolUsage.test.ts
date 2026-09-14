import { beforeEach, describe, expect, it, vi } from 'vitest'
const disk = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async () => ({
      get: async (key: string) => structuredClone(disk.get(key)),
      set: async (key: string, value: unknown) => {
        disk.set(key, structuredClone(value))
      },
      save: async () => {},
    }),
  },
}))
import { openToolUsage } from '@/services/tools/usage'
describe('scoped tool usage', () => {
  beforeEach(() => disk.clear())
  it('persists only numeric summaries and separates identities across reloads', async () => {
    const usage = await openToolUsage('account-a')
    await usage.record('call-secret-id', 'fs_read', true, 12)
    await usage.record('call-secret-id', 'fs_read', false, 15)
    await usage.record('call-2', 'fs_read', false, 18)
    expect(await (await openToolUsage('account-a')).snapshot()).toEqual([
      { name: 'fs_read', calls: 2, successes: 1, failures: 1, durationMs: 30 },
    ])
    expect(await (await openToolUsage('account-b')).snapshot()).toEqual([])
    const stored = JSON.stringify([...disk.entries()])
    expect(stored).not.toMatch(/account-a|call-secret-id|arguments|prompt/)
    expect([...disk.keys()][0]).toMatch(/^[a-f0-9]{64}$/)
  })
  it('serializes concurrent chats without losing increments', async () => {
    const first = await openToolUsage('same-owner'),
      second = await openToolUsage('same-owner')
    await Promise.all([first.record('a', 'fs_read', true, 10), second.record('b', 'fs_read', true, 20)])
    expect(await first.snapshot()).toMatchObject([{ calls: 2, successes: 2, durationMs: 30 }])
  })
  it('ignores malformed storage and keeps unknown ownership session-only', async () => {
    const usage = await openToolUsage('owner')
    await usage.record('1', 'fs_read', true, 10)
    disk.set([...disk.keys()][0]!, [
      { name: 'fs_read', calls: -1, successes: 0, failures: 0, durationMs: 0 },
      { name: '<bad>', calls: 2 },
    ])
    expect(await usage.snapshot()).toEqual([])
    const session = await openToolUsage()
    await session.record('2', 'fs_read', true, NaN)
    expect(await session.snapshot()).toMatchObject([{ calls: 1, durationMs: 0 }])
    expect(await (await openToolUsage()).snapshot()).toEqual([])
  })
})
