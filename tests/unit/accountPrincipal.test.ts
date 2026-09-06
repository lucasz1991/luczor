import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const bindingValues = new Map<string, unknown>()
  return {
    config: {
      baseUrl: 'HTTPS://Memory.Example.test:443/some/path/',
      deviceKey: 'device-key-a',
      clientId: 'desktop-1',
    },
    accountId: 41 as number | null,
    bindingValues,
    bindingStore: {
      get: vi.fn(async (key: string) => bindingValues.get(key)),
      set: vi.fn(async (key: string, value: unknown) => bindingValues.set(key, value)),
      save: vi.fn(async () => undefined),
    },
    invoke: vi.fn(async () => '22'.repeat(32)),
    getApiConfigSnapshot: vi.fn(),
    bootstrapWithApiConfig: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: harness.invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: vi.fn(async () => harness.bindingStore) },
}))

vi.mock('@/services/api/luczorApi', () => ({
  getApiConfigSnapshot: harness.getApiConfigSnapshot,
  bootstrapWithApiConfig: harness.bootstrapWithApiConfig,
}))

describe('verified account principal', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubGlobal('window', new EventTarget())
    vi.spyOn(window, 'addEventListener')
    harness.bindingValues.clear()
    harness.config = {
      baseUrl: 'HTTPS://Memory.Example.test:443/some/path/',
      deviceKey: 'device-key-a',
      clientId: 'desktop-1',
    }
    harness.accountId = 41
    harness.getApiConfigSnapshot.mockImplementation(async () => ({ ...harness.config }))
    harness.bootstrapWithApiConfig.mockReset().mockImplementation(async () => ({
      user: { id: harness.accountId, name: 'Account', email: 'account@example.test' },
      device: { id: 'device-1', name: 'Desktop', abilities: ['settings.read'] },
      runtime_settings: { api_prefix: '/api/v1', registration_enabled: false },
      routing: { managed_by: 'server', client_model_selection: false },
    }))
  })

  afterEach(() => {
    for (const [type, listener, options] of vi.mocked(window.addEventListener).mock.calls) {
      if (type.startsWith('luczor:api-identity-')) window.removeEventListener(type, listener, options)
    }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the principal stable across Device-Key rotation and canonical URL variants', async () => {
    const { deriveLocalModelManifestTrustDomain, getVerifiedAccountSnapshot } =
      await import('@/services/accountPrincipal')

    const first = await getVerifiedAccountSnapshot()
    harness.config = {
      baseUrl: 'https://memory.example.test/some/path',
      deviceKey: 'device-key-b',
      clientId: 'desktop-1',
    }
    const rotated = await getVerifiedAccountSnapshot()

    expect(first?.principalId).toMatch(/^account:v2:[a-f0-9]{64}$/)
    expect(rotated?.principalId).toBe(first?.principalId)
    expect(rotated?.config.deviceKey).toBe('device-key-b')
    await expect(deriveLocalModelManifestTrustDomain(first!)).resolves.toBe(
      await deriveLocalModelManifestTrustDomain(rotated!)
    )
    expect(Object.isFrozen(rotated)).toBe(true)
    expect(Object.isFrozen(rotated?.config)).toBe(true)
  })

  it('uses the normalized deployment path to separate server instances on the same origin', async () => {
    const { deriveLocalModelManifestTrustDomain, getVerifiedAccountSnapshot } =
      await import('@/services/accountPrincipal')

    harness.config.baseUrl = 'https://memory.example.test/luczor-a/'
    const first = await getVerifiedAccountSnapshot()
    harness.config.baseUrl = 'https://memory.example.test/luczor-b/'
    const second = await getVerifiedAccountSnapshot()

    expect(first?.serverOrigin).toBe(second?.serverOrigin)
    expect(first?.serverInstance).toBe('https://memory.example.test/luczor-a')
    expect(second?.serverInstance).toBe('https://memory.example.test/luczor-b')
    expect(second?.principalId).not.toBe(first?.principalId)
    expect(await deriveLocalModelManifestTrustDomain(first!)).toMatch(/^server:v1:[a-f0-9]{64}$/)
    expect(await deriveLocalModelManifestTrustDomain(second!)).not.toBe(
      await deriveLocalModelManifestTrustDomain(first!)
    )
  })

  it('partitions different authenticated server users and passes one exact config snapshot to bootstrap', async () => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')

    const first = await getVerifiedAccountSnapshot()
    const bootstrapConfig = harness.bootstrapWithApiConfig.mock.calls[0]?.[0]
    expect(bootstrapConfig).toBe(first?.config)

    harness.config.deviceKey = 'device-key-b'
    harness.accountId = 42
    const second = await getVerifiedAccountSnapshot()
    expect(second?.principalId).not.toBe(first?.principalId)
  })

  it('resolves a previously verified credential offline from its encrypted binding', async () => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')

    const online = await getVerifiedAccountSnapshot()
    const encrypted = String(harness.bindingValues.get('bindings_v1_encrypted'))
    // A short decimal account ID can occur by chance in randomized Base64
    // ciphertext. Assert that the serialized plaintext field is absent.
    expect(encrypted).not.toContain(`"accountId":${String(harness.accountId)}`)
    expect(encrypted).not.toContain(String(online?.principalId))

    harness.bootstrapWithApiConfig.mockRejectedValueOnce({ status: 0, message: 'network unavailable' })
    const offline = await getVerifiedAccountSnapshot()
    expect(offline).toMatchObject({
      principalId: online?.principalId,
      accountId: online?.accountId,
      serverOrigin: online?.serverOrigin,
      serverInstance: online?.serverInstance,
    })

    harness.bootstrapWithApiConfig.mockRejectedValueOnce({ status: 503, message: 'maintenance' })
    await expect(getVerifiedAccountSnapshot()).resolves.toMatchObject({ principalId: online?.principalId })
  })

  it('rejects an unknown rotated credential offline and an HTTP-rejected cached credential', async () => {
    const { AccountPrincipalVerificationError, getVerifiedAccountSnapshot } =
      await import('@/services/accountPrincipal')

    await getVerifiedAccountSnapshot()
    harness.config.deviceKey = 'unverified-rotated-key'
    harness.bootstrapWithApiConfig.mockRejectedValueOnce({ status: 0, message: 'network unavailable' })
    await expect(getVerifiedAccountSnapshot()).rejects.toBeInstanceOf(AccountPrincipalVerificationError)

    harness.config.deviceKey = 'device-key-a'
    harness.bootstrapWithApiConfig.mockRejectedValueOnce({ status: 401, message: 'unauthorized' })
    await expect(getVerifiedAccountSnapshot()).rejects.toBeInstanceOf(AccountPrincipalVerificationError)
  })

  it('rejects a contradictory live account for an already bound credential', async () => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')

    await getVerifiedAccountSnapshot()
    harness.accountId = 42
    await expect(getVerifiedAccountSnapshot()).rejects.toThrow('widerspricht')
  })

  it('returns device-local absence only without a key and otherwise fails closed', async () => {
    const { AccountPrincipalVerificationError, getVerifiedAccountSnapshot } =
      await import('@/services/accountPrincipal')

    harness.config.deviceKey = ''
    await expect(getVerifiedAccountSnapshot()).resolves.toBeNull()
    expect(harness.bootstrapWithApiConfig).not.toHaveBeenCalled()

    harness.config.deviceKey = 'configured-key'
    harness.bootstrapWithApiConfig.mockRejectedValueOnce(new Error('offline'))
    await expect(getVerifiedAccountSnapshot()).rejects.toBeInstanceOf(AccountPrincipalVerificationError)
  })

  it('shares one pending bootstrap between concurrent consumers of the exact identity', async () => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')
    let finish!: (value: { user: { id: number } }) => void
    harness.bootstrapWithApiConfig.mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))

    const requests = Array.from({ length: 20 }, () => getVerifiedAccountSnapshot())
    await vi.waitFor(() => expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(1))
    finish({ user: { id: 41 } })
    const snapshots = await Promise.all(requests)

    expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(1)
    expect(new Set(snapshots).size).toBe(1)
    expect(harness.bindingStore.save).toHaveBeenCalledTimes(1)
  })

  it('retries an unknown offline identity after five seconds without granting cached access', async () => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    harness.bootstrapWithApiConfig.mockRejectedValueOnce({ status: 0, message: 'network unavailable' })

    await expect(getVerifiedAccountSnapshot()).rejects.toThrow('noch nicht live')
    now += 4_999
    await expect(getVerifiedAccountSnapshot()).rejects.toThrow('noch nicht live')
    expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(1)
    now += 1
    await expect(getVerifiedAccountSnapshot()).resolves.toMatchObject({ accountId: 41 })
    expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(2)
  })

  it('checks the protected offline binding again during the transport retry delay', async () => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')
    await getVerifiedAccountSnapshot()
    harness.bootstrapWithApiConfig.mockRejectedValueOnce({ status: 503, message: 'maintenance' })
    await expect(getVerifiedAccountSnapshot()).resolves.toMatchObject({ accountId: 41 })
    harness.bindingValues.clear()

    await expect(getVerifiedAccountSnapshot()).rejects.toThrow('noch nicht live')
    expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403])('does not cache an HTTP %i rejection or reuse an earlier success', async status => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')
    await getVerifiedAccountSnapshot()
    harness.bootstrapWithApiConfig.mockRejectedValueOnce({ status, message: 'denied' })

    await expect(getVerifiedAccountSnapshot()).rejects.toThrow('nicht sicher')
    await expect(getVerifiedAccountSnapshot()).resolves.toMatchObject({ accountId: 41 })
    expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(3)
  })

  it.each([
    { field: 'deviceKey', changes: { deviceKey: 'another-key' } },
    { field: 'clientId', changes: { clientId: 'another-client' } },
    { field: 'baseUrl', changes: { baseUrl: 'https://another.example.test' } },
  ])('never shares a pending verification across a changed $field', async ({ changes }) => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')
    let finish!: (value: { user: { id: number } }) => void
    harness.bootstrapWithApiConfig.mockImplementationOnce(() => new Promise(resolve => (finish = resolve)))
    const first = getVerifiedAccountSnapshot()
    await vi.waitFor(() => expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(1))
    const original = { ...harness.config }
    harness.config = { ...harness.config, ...changes }
    const second = await getVerifiedAccountSnapshot()
    finish({ user: { id: 41 } })

    expect((await first)?.config).toEqual(original)
    expect(second?.config).toEqual(harness.config)
    expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(2)
  })

  it('clears transport delay when the identity is reconfigured', async () => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')
    harness.bootstrapWithApiConfig.mockRejectedValueOnce({ status: 0, message: 'network unavailable' })
    await expect(getVerifiedAccountSnapshot()).rejects.toThrow('noch nicht live')
    window.dispatchEvent(new Event('luczor:api-identity-changing'))
    await expect(getVerifiedAccountSnapshot()).rejects.toThrow('Konfiguration')
    window.dispatchEvent(new Event('luczor:api-identity-changed'))

    await expect(getVerifiedAccountSnapshot()).resolves.toMatchObject({ accountId: 41 })
    expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(2)
  })

  it('rejects late results after an identity boundary without repopulating transport delay', async () => {
    const { getVerifiedAccountSnapshot } = await import('@/services/accountPrincipal')
    let fail!: (cause: unknown) => void
    harness.bootstrapWithApiConfig.mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
    const stale = getVerifiedAccountSnapshot().catch(error => error)
    await vi.waitFor(() => expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new Event('luczor:api-identity-changing'))
    window.dispatchEvent(new Event('luczor:api-identity-changed'))
    await expect(getVerifiedAccountSnapshot()).resolves.toMatchObject({ accountId: 41 })
    fail({ status: 0, message: 'retired request failed' })
    expect(await stale).toMatchObject({ message: expect.stringContaining('Konfiguration') })

    await expect(getVerifiedAccountSnapshot()).resolves.toMatchObject({ accountId: 41 })
    expect(harness.bootstrapWithApiConfig).toHaveBeenCalledTimes(3)
  })
})
