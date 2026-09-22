import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ isTauri: vi.fn(() => false), load: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: native.isTauri }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: native.load } }))

describe('appearance preferences', () => {
  let values: Map<string, string>
  let root: { dataset: Record<string, string>; style: { setProperty: ReturnType<typeof vi.fn>; colorScheme: string } }
  let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> }
  let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.resetModules()
    native.isTauri.mockReturnValue(false)
    native.load.mockReset()
    values = new Map()
    root = { dataset: {}, style: { setProperty: vi.fn(), colorScheme: '' } }
    storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    }
    media = { matches: false, addEventListener: vi.fn() }
    vi.stubGlobal('window', { localStorage: storage, matchMedia: () => media })
    vi.stubGlobal('document', { documentElement: root })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('restores browser choices after a new module load without using native storage', async () => {
    const first = await import('@/services/appearance')
    await first.setTheme('light')
    expect(root.dataset.theme).toBe('light')
    vi.resetModules()
    const reloaded = await import('@/services/appearance')
    await reloaded.loadAppearance()
    expect(reloaded.appearance.theme).toBe('light')
    expect(root.style.colorScheme).toBe('light')
    await reloaded.toggleTheme()
    expect(root.dataset.theme).toBe('dark')
    expect(values.get('luczor.ui.theme')).toBe('dark')
    expect(native.load).not.toHaveBeenCalled()
  })

  it('ignores invalid browser preferences', async () => {
    values.set('luczor.ui.theme', 'unexpected')
    const service = await import('@/services/appearance')
    await service.loadAppearance()
    expect(root.dataset.theme).toBe('dark')
  })

  it('still switches when browser storage is unavailable', async () => {
    storage.getItem.mockImplementation(() => {
      throw new Error('Storage denied')
    })
    storage.setItem.mockImplementation(() => {
      throw new Error('Storage denied')
    })
    const service = await import('@/services/appearance')
    await service.loadAppearance()
    await service.setTheme('light')
    expect(root.dataset.theme).toBe('light')
  })

  it('keeps native settings authoritative and writes to the Tauri store', async () => {
    native.isTauri.mockReturnValue(true)
    values.set('luczor.ui.theme', 'dark')
    const store = {
      get: vi.fn(async (key: string) => (key === 'ui_theme' ? 'light' : null)),
      set: vi.fn(),
      save: vi.fn(),
    }
    native.load.mockResolvedValue(store)
    const service = await import('@/services/appearance')
    await service.loadAppearance()
    expect(root.dataset.theme).toBe('light')
    await service.setTheme('dark')
    expect(store.set).toHaveBeenCalledWith('ui_theme', 'dark')
    expect(store.save).toHaveBeenCalledOnce()
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('follows OS changes only while system mode is selected', async () => {
    values.set('luczor.ui.theme', 'system')
    media.matches = true
    const service = await import('@/services/appearance')
    await service.loadAppearance()
    expect(root.dataset.theme).toBe('light')
    expect(root.dataset.themeMode).toBe('system')
    const change = media.addEventListener.mock.calls[0]![1] as () => void
    media.matches = false
    change()
    expect(root.dataset.theme).toBe('dark')
    await service.setTheme('light')
    change()
    expect(root.dataset.theme).toBe('light')
    expect(media.addEventListener).toHaveBeenCalledOnce()
  })
})
