import { beforeEach, expect, it, vi } from 'vitest'
const store = vi.hoisted(() => ({ get: vi.fn(), load: vi.fn() }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: store.load } }))
import { loadToolLimits, validToolRounds } from '@/services/toolLimits'
beforeEach(() => {
  store.load.mockResolvedValue(store)
  store.get.mockReset()
})
it('loads separate persisted chat and worker limits', async () => {
  store.get.mockImplementation(async key => (key === 'chat_tool_rounds' ? 18 : 32))
  expect(await loadToolLimits()).toEqual({ chat: 18, agent: 32 })
})
it('rejects invalid limits and recovers defaults from a missing store', async () => {
  for (const value of [0, -1, 65, 1.5, NaN, Infinity, '12', null]) expect(validToolRounds(value)).toBe(false)
  expect(validToolRounds(1)).toBe(true)
  expect(validToolRounds(64)).toBe(true)
  store.get.mockResolvedValue(0)
  expect(await loadToolLimits()).toEqual({ chat: 6, agent: 12 })
  store.load.mockRejectedValueOnce(new Error('unavailable'))
  expect(await loadToolLimits()).toEqual({ chat: 6, agent: 12 })
})
