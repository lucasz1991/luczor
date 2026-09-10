import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ load: vi.fn(), get: vi.fn(), set: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: native.load } }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
  native.load.mockResolvedValue(native)
  native.set.mockResolvedValue(undefined)
  native.save.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllGlobals())

it('restores saved device choices after a new webview origin with empty localStorage', async () => {
  let disk: unknown
  let pending: unknown
  native.get.mockImplementation(async () => disk)
  native.set.mockImplementation(async (_key, value) => {
    pending = structuredClone(value)
  })
  native.save.mockImplementation(async () => {
    disk = pending
  })
  const first = await import('@/services/inference/modelUsageSettings')
  const choice = { ...first.DEFAULT_MODEL_USAGE, localModelId: 'local-tier-light', agentsByDefault: true }
  await first.saveModelUsageSettings(choice)
  vi.resetModules()
  const restarted = await import('@/services/inference/modelUsageSettings')
  await restarted.initializeModelUsageSettings()
  expect(restarted.modelUsageSettings.value).toEqual(choice)
  expect(native.load).toHaveBeenCalledWith('luczor.model-usage.json', { autoSave: false, defaults: {} })
  expect(localStorage.setItem).not.toHaveBeenCalled()
})

it('does not replace an existing device selection with stale browser settings', async () => {
  const saved = {
    localModelId: 'local-tier-light',
    externalEnabled: false,
    agentsByDefault: false,
    teamPreset: 'local',
  }
  native.get.mockResolvedValue(saved)
  vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify({ localModelId: 'old-large-model' }))
  const settings = await import('@/services/inference/modelUsageSettings')
  await settings.initializeModelUsageSettings()
  expect(settings.modelUsageSettings.value).toEqual(saved)
  expect(native.set).not.toHaveBeenCalled()
})

it('awaits disk persistence and keeps the applied selection when saving fails', async () => {
  native.get.mockResolvedValue({ localModelId: 'local-tier-light' })
  const settings = await import('@/services/inference/modelUsageSettings')
  await settings.initializeModelUsageSettings()
  native.save.mockRejectedValue(new Error('disk full'))
  await expect(
    settings.saveModelUsageSettings({ ...settings.DEFAULT_MODEL_USAGE, localModelId: 'large' })
  ).rejects.toThrow('disk full')
  expect(settings.modelUsageSettings.value.localModelId).toBe('local-tier-light')
})
