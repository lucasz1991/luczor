import { describe, expect, it, vi } from 'vitest'
import { createApiIdentityWriter, DISABLED_API_BASE_URL } from '@/services/apiIdentitySettings'

vi.mock('@/services/inference/coordinator', () => ({ invalidateLocalInferenceApiIdentity: vi.fn() }))
vi.mock('@/services/voice/speak', () => ({ suspendSpeech: vi.fn(() => vi.fn()) }))

const originalBase = 'https://first.example.test'
const originalKey = 'first-device-key'
const nextBase = 'https://second.example.test'
const nextKey = 'second-device-key'

function fixture() {
  const state = {
    memoryBase: originalBase,
    diskBase: originalBase,
    cachedKey: originalKey,
    nativeKey: originalKey,
    failKeyWrite: false,
    failFirstSave: false,
    failPublish: false,
  }
  const events: string[] = []
  const resume = vi.fn()
  const suspend = vi.fn(() => resume)
  const beforeChange = vi.fn(async (): Promise<void> => undefined)
  const readIdentity = vi.fn(async () => ({ baseUrl: state.memoryBase, deviceKey: state.cachedKey }))
  const writeDeviceKey = vi.fn(async (value: string) => {
    // Every native/key-cache transition must be preceded by a durable disconnected URL.
    expect(state.diskBase).toBe(DISABLED_API_BASE_URL)
    expect(state.memoryBase).toBe(DISABLED_API_BASE_URL)
    events.push(value ? 'key:write' : 'key:clear')
    state.nativeKey = value
    if (value && state.failKeyWrite) {
      state.failKeyWrite = false
      throw new Error(`native verification failed for SECRET ${value}`)
    }
    state.cachedKey = value
  })
  const store = {
    set: vi.fn(async (_key: string, value: string) => {
      events.push(`url:${value}`)
      state.memoryBase = value
    }),
    save: vi.fn(async () => {
      events.push(`persist:${state.memoryBase}`)
      if (state.failFirstSave) {
        state.failFirstSave = false
        throw new Error('storage unavailable')
      }
      if (state.failPublish && state.memoryBase === nextBase) {
        state.failPublish = false
        throw new Error('target URL could not be persisted')
      }
      state.diskBase = state.memoryBase
    }),
  }
  const write = createApiIdentityWriter({ readIdentity, writeDeviceKey, suspendSpeech: suspend, beforeChange })
  return { state, store, events, resume, suspend, write, readIdentity, writeDeviceKey, beforeChange }
}

describe('Settings API identity persistence', () => {
  it('disconnects durably, replaces the protected credential, then publishes the matching server', async () => {
    const test = fixture()
    await expect(test.write(test.store, `${nextBase}/`, ` ${nextKey} `)).resolves.toBe(true)
    expect(test.events).toEqual([
      `url:${DISABLED_API_BASE_URL}`,
      `persist:${DISABLED_API_BASE_URL}`,
      'key:clear',
      'key:write',
      `url:${nextBase}`,
      `persist:${nextBase}`,
    ])
    expect(test.state).toMatchObject({
      memoryBase: nextBase,
      diskBase: nextBase,
      nativeKey: nextKey,
      cachedKey: nextKey,
    })
    expect(test.suspend).toHaveBeenCalledOnce()
    expect(test.beforeChange).toHaveBeenCalledOnce()
    expect(test.resume).toHaveBeenCalledOnce()
  })

  it('does not interrupt speech or rewrite credentials when the identity is unchanged', async () => {
    const test = fixture()
    await expect(test.write(test.store, originalBase, originalKey)).resolves.toBe(false)
    expect(test.suspend).not.toHaveBeenCalled()
    expect(test.store.set).not.toHaveBeenCalled()
    expect(test.writeDeviceKey).not.toHaveBeenCalled()
  })

  it('stays disconnected and suspended when native key writing succeeds but verification fails', async () => {
    const test = fixture()
    test.state.failKeyWrite = true
    const error = await test.write(test.store, nextBase, nextKey).catch((caught: unknown) => caught)
    expect(String(error)).toContain('erneut erfolgreich gespeichert')
    expect(String(error)).not.toContain(nextKey)
    expect(String(error)).not.toContain('SECRET')
    expect(test.state).toMatchObject({
      diskBase: DISABLED_API_BASE_URL,
      memoryBase: DISABLED_API_BASE_URL,
      nativeKey: nextKey,
      cachedKey: '',
    })
    expect(test.resume).not.toHaveBeenCalled()
  })

  it('can safely retry the original pair after a partially written replacement key', async () => {
    const test = fixture()
    test.state.failKeyWrite = true
    await expect(test.write(test.store, nextBase, nextKey)).rejects.toThrow('nicht sicher gespeichert')
    await expect(test.write(test.store, originalBase, originalKey)).resolves.toBe(true)
    expect(test.state).toMatchObject({
      diskBase: originalBase,
      memoryBase: originalBase,
      nativeKey: originalKey,
      cachedKey: originalKey,
    })
    expect(test.writeDeviceKey.mock.calls.map(call => call[0])).toEqual(['', nextKey, '', originalKey])
    expect(test.suspend).toHaveBeenCalledOnce()
    expect(test.resume).toHaveBeenCalledOnce()
  })

  it('never touches the credential if the disconnected URL could not be persisted first', async () => {
    const test = fixture()
    test.state.failFirstSave = true
    await expect(test.write(test.store, nextBase, nextKey)).rejects.toThrow('nicht sicher gespeichert')
    expect(test.writeDeviceKey).not.toHaveBeenCalled()
    expect(test.state.nativeKey).toBe(originalKey)
    expect(test.state.diskBase).toBe(DISABLED_API_BASE_URL)
    expect(test.resume).not.toHaveBeenCalled()
  })

  it('returns to a disconnected state if final URL persistence fails and permits a successful retry', async () => {
    const test = fixture()
    test.state.failPublish = true
    await expect(test.write(test.store, nextBase, nextKey)).rejects.toThrow('nicht sicher gespeichert')
    expect(test.state).toMatchObject({
      diskBase: DISABLED_API_BASE_URL,
      memoryBase: DISABLED_API_BASE_URL,
      nativeKey: nextKey,
    })
    expect(test.resume).not.toHaveBeenCalled()
    await expect(test.write(test.store, nextBase, nextKey)).resolves.toBe(true)
    expect(test.state).toMatchObject({ diskBase: nextBase, memoryBase: nextBase, nativeKey: nextKey })
    expect(test.resume).toHaveBeenCalledOnce()
  })

  it('retains the original pair and blocks speech if storage rejects every attempted write', async () => {
    const test = fixture()
    test.store.set.mockRejectedValue(new Error('disk unavailable'))
    await expect(test.write(test.store, nextBase, nextKey)).rejects.toThrow('Sprachausgabe bleibt gesperrt')
    expect(test.state).toMatchObject({ diskBase: originalBase, nativeKey: originalKey, memoryBase: originalBase })
    expect(test.writeDeviceKey).not.toHaveBeenCalled()
    expect(test.resume).not.toHaveBeenCalled()
  })

  it('keeps speech blocked on identity-read failure and recovers through a subsequent verified write', async () => {
    const test = fixture()
    test.readIdentity.mockRejectedValueOnce(new Error('credential store unavailable'))
    await expect(test.write(test.store, nextBase, nextKey)).rejects.toThrow('Sprachausgabe bleibt gesperrt')
    expect(test.store.set).not.toHaveBeenCalled()
    expect(test.resume).not.toHaveBeenCalled()
    await expect(test.write(test.store, originalBase, originalKey)).resolves.toBe(true)
    expect(test.resume).toHaveBeenCalledOnce()
  })

  it('serializes overlapping saves so each published URL has its own verified key', async () => {
    const test = fixture()
    let release!: () => void
    test.beforeChange.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const first = test.write(test.store, nextBase, nextKey)
    const second = test.write(test.store, originalBase, originalKey)
    await Promise.resolve()
    await Promise.resolve()
    expect(test.beforeChange).toHaveBeenCalledOnce()
    expect(test.readIdentity).toHaveBeenCalledOnce()
    release()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(test.events.filter(event => event.startsWith('persist:https:'))).toEqual([
      `persist:${nextBase}`,
      `persist:${originalBase}`,
    ])
    expect(test.state).toMatchObject({ diskBase: originalBase, memoryBase: originalBase, nativeKey: originalKey })
    expect(test.resume).toHaveBeenCalledTimes(2)
  })

  it('can explicitly remove the device key without writing a replacement', async () => {
    const test = fixture()
    await expect(test.write(test.store, originalBase, '')).resolves.toBe(true)
    expect(test.writeDeviceKey).toHaveBeenCalledExactlyOnceWith('')
    expect(test.state).toMatchObject({ diskBase: originalBase, nativeKey: '', cachedKey: '' })
    expect(test.resume).toHaveBeenCalledOnce()
  })

  it.each([DISABLED_API_BASE_URL, 'not a URL', 'https://user:secret@example.test'])(
    'does not publish an invalid or disconnected target %s',
    async target => {
      const test = fixture()
      await expect(test.write(test.store, target, nextKey)).rejects.toThrow('Server-URL und Device-Key prüfen')
      expect(test.store.set).not.toHaveBeenCalled()
      expect(test.writeDeviceKey).not.toHaveBeenCalled()
      expect(test.resume).not.toHaveBeenCalled()
    }
  )
})
