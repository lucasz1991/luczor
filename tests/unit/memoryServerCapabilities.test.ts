import { beforeEach, describe, expect, it, vi } from 'vitest'
const fetcher = vi.hoisted(() => vi.fn())
vi.mock('@/services/api/luczorApi', () => ({ fetchBoundedResponseWithTimeout: fetcher }))
import { clearMemoryCapabilitiesCache, getMemoryServerCapabilities } from '@/services/memory/memoryServerCapabilities'

const account = {
  principalId: 'a',
  serverInstance: 'https://luczor.test',
  serverOrigin: 'https://luczor.test',
  accountId: 1,
  config: { baseUrl: 'https://luczor.test/', clientId: 'device', deviceKey: 'synthetic-secret' },
}
describe('independent identity-bound memory capability discovery', () => {
  beforeEach(() => {
    clearMemoryCapabilitiesCache()
    vi.clearAllMocks()
  })
  it('coalesces annotations and uses the dedicated GET endpoint with frozen credentials', async () => {
    fetcher.mockResolvedValue({
      response: new Response('{}'),
      text: JSON.stringify({ capabilities: { memory_metadata_cas: true } }),
    })
    await Promise.all([getMemoryServerCapabilities(account), getMemoryServerCapabilities(account)])
    await getMemoryServerCapabilities(account)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]![0]).toBe('https://luczor.test/api/v1/memory/capabilities')
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
    await getMemoryServerCapabilities({ ...account, principalId: 'b' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('caches unsupported older servers without maintenance endpoint probes', async () => {
    fetcher.mockResolvedValue({ response: new Response('{}', { status: 404 }), text: '{}' })
    expect(await getMemoryServerCapabilities(account)).toEqual({})
    expect(await getMemoryServerCapabilities(account)).toEqual({})
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('never caches authorization failure as old-server support', async () => {
    fetcher.mockResolvedValue({ response: new Response('{}', { status: 401 }), text: '{}' })
    await expect(getMemoryServerCapabilities(account)).rejects.toThrow('401')
    await expect(getMemoryServerCapabilities(account)).rejects.toThrow('401')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
