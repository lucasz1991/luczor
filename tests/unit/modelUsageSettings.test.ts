import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localInferenceCoordinator, resolveInferenceRouteForTurn } from '@/services/inference/coordinator'
import {
  parseModelUsage,
  saveModelUsageSettings,
  modelUsageSettings,
  DEFAULT_MODEL_USAGE,
} from '@/services/inference/modelUsageSettings'

beforeEach(() => {
  vi.stubGlobal('localStorage', { setItem: vi.fn() })
  modelUsageSettings.value = { ...DEFAULT_MODEL_USAGE }
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('defaults external routing off and rejects invalid stored selections', () => {
  expect(parseModelUsage({ externalEnabled: 'true', localModelId: '../../file', teamPreset: 'other' })).toEqual(
    DEFAULT_MODEL_USAGE
  )
})
it('persists model and route choices together before publishing them', async () => {
  const choice = {
    localModelId: 'local-tier-light',
    externalEnabled: true,
    chatRouteMode: 'auto' as const,
  }
  await saveModelUsageSettings(choice)
  expect(modelUsageSettings.value).toEqual(choice)
  expect(localStorage.setItem).toHaveBeenCalledWith('luczor.device.model-usage.v1', JSON.stringify(choice))
})
it('does not publish unsaved choices when device storage rejects the write', async () => {
  vi.mocked(localStorage.setItem).mockImplementation(() => {
    throw new Error('storage full')
  })
  await expect(saveModelUsageSettings({ ...DEFAULT_MODEL_USAGE, externalEnabled: true })).rejects.toThrow(
    'storage full'
  )
  expect(modelUsageSettings.value.externalEnabled).toBe(false)
})

it('the shared entry point blocks external routes even when a caller asks for one', async () => {
  modelUsageSettings.value = { ...DEFAULT_MODEL_USAGE, localModelId: 'local-tier-light' }
  const resolve = vi.spyOn(localInferenceCoordinator, 'resolveTurn').mockRejectedValue(new Error('captured'))
  await expect(
    resolveInferenceRouteForTurn({
      projectId: 'p',
      contextEgress: 'external_allowed',
      routingSettings: { preference: 'allow_external' },
    })
  ).rejects.toThrow('captured')
  expect(resolve).toHaveBeenCalledWith(
    expect.objectContaining({
      contextEgress: 'local_only',
      externalPackage: undefined,
      routingSettings: { preference: 'local_only', localModelId: 'local-tier-light' },
    })
  )
})
