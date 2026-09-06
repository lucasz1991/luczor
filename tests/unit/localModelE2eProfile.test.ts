import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  const store = {
    get: vi.fn(async (key: string) => values.get(key)),
    has: vi.fn(async (key: string) => values.has(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key)
    }),
    save: vi.fn(async () => undefined),
  }
  return { values, store, load: vi.fn(async () => store) }
})

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: harness.load } }))

import {
  applyLocalModelE2eSettings,
  matchesLocalModelE2eSettingsSnapshot,
  restoreLocalModelE2eSettings,
  snapshotLocalModelE2eSettings,
  verifyLocalModelE2eSettings,
} from '@/services/inference/localModelE2eProfile'

describe('localModelE2eProfile', () => {
  beforeEach(() => {
    harness.values.clear()
    vi.clearAllMocks()
  })

  it('applies a fail-closed loopback-only profile and restores the exact prior values', async () => {
    harness.values.set('active_mode', 'act')
    harness.values.set('memory_inject', true)
    harness.values.set('luczor_api_base_url', 'https://control.example.test')
    const snapshot = await snapshotLocalModelE2eSettings()

    await applyLocalModelE2eSettings('http://127.0.0.1:8765/')

    await expect(verifyLocalModelE2eSettings('http://127.0.0.1:8765')).resolves.toBe(true)
    expect(harness.values.get('active_mode')).toBe('observe')
    expect(harness.values.get('allow_unrestricted')).toBe(false)
    expect(harness.values.get('auto_execute_mutating_tools')).toBe(false)
    expect(harness.values.get('memory_inject')).toBe(false)
    expect(harness.values.get('memory_use_server')).toBe(false)
    expect(harness.values.get('sync_auto')).toBe(false)
    expect(harness.values.get('local_model_flash_experiment')).toBe(false)
    expect(harness.values.get('chat_auto_speech')).toBe(false)
    expect(harness.values.get('luczor_api_base_url')).toBe('http://127.0.0.1:8765')

    await restoreLocalModelE2eSettings(snapshot)

    await expect(matchesLocalModelE2eSettingsSnapshot(snapshot)).resolves.toBe(true)
    expect(harness.values.get('active_mode')).toBe('act')
    expect(harness.values.get('memory_inject')).toBe(true)
    expect(harness.values.get('luczor_api_base_url')).toBe('https://control.example.test')
    expect(harness.values.has('sync_auto')).toBe(false)
    expect(harness.store.has).not.toHaveBeenCalled()
  })

  it('rejects a non-loopback control plane before persisting it', async () => {
    await expect(applyLocalModelE2eSettings('https://control.example.test')).rejects.toThrow(
      'accepts only a loopback control plane'
    )
    expect(harness.values.has('luczor_api_base_url')).toBe(false)
  })
})
