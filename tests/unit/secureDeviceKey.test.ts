import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  let secureValue: string | null = null
  const invoke = vi.fn(async (command: string, args?: { payload?: { value?: string } }) => {
    if (command === 'device_key_get') return secureValue
    if (command === 'device_key_set') {
      secureValue = args?.payload?.value ?? null
      return
    }
    if (command === 'device_key_delete') {
      secureValue = null
      return
    }
    throw new Error(`Unexpected command: ${command}`)
  })
  const store = {
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: unknown) => values.set(key, value)),
    delete: vi.fn(async (key: string) => values.delete(key)),
    save: vi.fn(async () => {}),
  }
  return {
    values,
    invoke,
    store,
    get secureValue() {
      return secureValue
    },
    set secureValue(value: string | null) {
      secureValue = value
    },
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: harness.invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: vi.fn(async () => harness.store) },
}))

describe('secure device key migration', () => {
  beforeEach(() => {
    vi.resetModules()
    harness.values.clear()
    harness.secureValue = null
    harness.invoke.mockClear()
    harness.store.get.mockClear()
    harness.store.delete.mockClear()
    harness.store.save.mockReset().mockResolvedValue(undefined)
  })

  it('moves only the legacy device key after OS-keychain read-back succeeds', async () => {
    harness.values.set('luczor_device_key', ' legacy-device-token ')
    harness.values.set('assistant_name', 'Jarvis')
    const { loadDeviceKey } = await import('@/services/secureDeviceKey')

    await expect(loadDeviceKey()).resolves.toBe('legacy-device-token')

    expect(harness.secureValue).toBe('legacy-device-token')
    expect(harness.values.has('luczor_device_key')).toBe(false)
    expect(harness.values.get('assistant_name')).toBe('Jarvis')
    expect(harness.store.save).toHaveBeenCalledOnce()
  })

  it('keeps the plaintext legacy value when the protected write fails', async () => {
    harness.values.set('luczor_device_key', 'legacy-device-token')
    harness.invoke.mockImplementationOnce(async () => null).mockRejectedValueOnce(new Error('keychain locked'))
    const { loadDeviceKey } = await import('@/services/secureDeviceKey')

    await expect(loadDeviceKey()).rejects.toThrow('keychain locked')

    expect(harness.values.get('luczor_device_key')).toBe('legacy-device-token')
    expect(harness.store.delete).not.toHaveBeenCalled()
  })

  it('removes a stale plaintext duplicate when a protected key already exists', async () => {
    harness.secureValue = 'protected-token'
    harness.values.set('luczor_device_key', 'stale-token')
    const { loadDeviceKey } = await import('@/services/secureDeviceKey')

    await expect(loadDeviceKey()).resolves.toBe('protected-token')

    expect(harness.values.has('luczor_device_key')).toBe(false)
    expect(harness.invoke).not.toHaveBeenCalledWith('device_key_set', expect.anything())
  })

  it('does not clear the protected key when legacy plaintext cleanup fails', async () => {
    harness.secureValue = 'protected-token'
    harness.values.set('luczor_device_key', 'legacy-token')
    harness.store.save.mockRejectedValueOnce(new Error('store locked'))
    const { saveDeviceKey } = await import('@/services/secureDeviceKey')

    await expect(saveDeviceKey('')).rejects.toThrow('store locked')

    expect(harness.secureValue).toBe('protected-token')
    expect(harness.invoke).not.toHaveBeenCalledWith('device_key_delete')
  })
})
