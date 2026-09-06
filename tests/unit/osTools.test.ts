import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Native desktop coordinates intentionally use x/y. */
/* eslint id-length: ['error', { exceptions: ['x', 'y'] }] */

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { lastScreenshot, osTools } from '@/services/tools/os'

const CONTEXT = { projectId: 'computer-test' }
const MONITORS = [
  { id: 7, name: 'Left', x: -1920, y: 0, width: 1920, height: 1080, scale_factor: 1, primary: false },
  { id: 9, name: 'Main', x: 0, y: 0, width: 3840, height: 2160, scale_factor: 1.5, primary: true },
]

function execute(name: string, args: Record<string, unknown> = {}) {
  const tool = osTools.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`Unknown test tool: ${name}`)
  return tool.execute(args, CONTEXT)
}

describe('native computer perception and input contracts', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    lastScreenshot.value = null
  })

  it('reports native multi-monitor geometry without screenshots or CSS screen assumptions', async () => {
    mocks.invoke.mockImplementation(async command => {
      if (command === 'list_monitors') return MONITORS
      if (command === 'list_windows') return [{ id: 32, title: 'Editor', x: -1800, focused: true }]
      if (command === 'system_metrics') return { cpu_percent: 17 }
      throw new Error(`Unexpected command: ${command}`)
    })

    const result = await execute('os_environment')

    expect(result).toMatchObject({
      ok: true,
      status: 'ready',
      sources: { windows: 'ready', monitors: 'ready', metrics: 'ready' },
      screenshot: false,
      coordinate_space: 'native_desktop_pixels',
      monitors: MONITORS,
      screen: { x: 0, y: 0, width: 3840, height: 2160, scale_factor: 1.5 },
    })
    expect(mocks.invoke).toHaveBeenCalledTimes(3)
    expect(mocks.invoke).not.toHaveBeenCalledWith('capture_screen')
  })

  it('distinguishes an unavailable source from a valid empty window list', async () => {
    mocks.invoke.mockImplementation(async command => {
      if (command === 'list_windows') return []
      if (command === 'list_monitors') return MONITORS
      throw new Error('Native metrics temporarily unavailable')
    })

    expect(await execute('os_environment')).toMatchObject({
      ok: false,
      status: 'partial',
      sources: { windows: 'ready', monitors: 'ready', metrics: 'unavailable' },
      windows: [],
      metrics: null,
      monitors: MONITORS,
    })
  })

  it('reports unavailable rather than success when all native calls fail', async () => {
    mocks.invoke.mockRejectedValue(new Error('Native bridge unavailable'))

    expect(await execute('os_environment')).toMatchObject({
      ok: false,
      status: 'unavailable',
      sources: { windows: 'unavailable', monitors: 'unavailable', metrics: 'unavailable' },
      windows: null,
      metrics: null,
      monitors: null,
      screen: null,
    })
  })

  it('does not read window titles when they are excluded', async () => {
    mocks.invoke.mockImplementation(async command => {
      if (command === 'list_monitors') return MONITORS
      if (command === 'system_metrics') return { cpu_percent: 2 }
      throw new Error(`Unexpected command: ${command}`)
    })

    expect(await execute('os_environment', { include_windows: false })).toMatchObject({
      ok: true,
      status: 'ready',
      sources: { windows: 'skipped', monitors: 'ready', metrics: 'ready' },
      windows: [],
    })
    expect(mocks.invoke).not.toHaveBeenCalledWith('list_windows')
  })

  it('selects an explicit monitor but keeps image bytes out of model output', async () => {
    mocks.invoke.mockResolvedValue({
      base64: 'aW1hZ2U=',
      mime: 'image/png',
      width: 1920,
      height: 1080,
      monitor: MONITORS[0],
    })

    const result = await execute('os_screen_capture', { monitor_id: 7 })

    expect(mocks.invoke).toHaveBeenCalledWith('capture_screen', { payload: { monitorId: 7 } })
    expect(result).toEqual({
      captured: true,
      width: 1920,
      height: 1080,
      monitor: MONITORS[0],
      coordinate_space: 'native_desktop_pixels',
    })
    expect(JSON.stringify(result)).not.toContain('aW1hZ2U=')
    expect(lastScreenshot.value).toBe('data:image/png;base64,aW1hZ2U=')
  })

  it('clears an old screenshot if the selected monitor disappears', async () => {
    lastScreenshot.value = 'data:image/png;base64,older-image'
    mocks.invoke.mockRejectedValue(new Error('Selected monitor is no longer available'))

    await expect(execute('os_screen_capture', { monitor_id: 7 })).rejects.toThrow('no longer available')
    expect(lastScreenshot.value).toBeNull()
  })

  it.each([
    { monitor_id: -1 },
    { monitor_id: 1.5 },
    { monitor_id: '7' },
    { monitor_id: 4294967296 },
    { monitor_id: 7, monitor: 'primary' },
    { monitor: 'first' },
  ])('rejects an invalid monitor selector without capture: %j', async args => {
    await expect(execute('os_screen_capture', args)).rejects.toThrow()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['os_move_mouse', { x: null, y: 0 }],
    ['os_move_mouse', { x: false, y: 0 }],
    ['os_move_mouse', { x: '', y: 0 }],
    ['os_move_mouse', { x: Number.NaN, y: 0 }],
    ['os_move_mouse', { x: 100_001, y: 0 }],
    ['os_click', { x: 12 }],
    ['os_click', { x: null, y: null }],
    ['os_click', { button: 'typo', x: 12, y: 10 }],
    ['os_click', { double: 'false' }],
    ['os_scroll', { amount: 0.4 }],
    ['os_scroll', { amount: '4' }],
  ] as Array<[string, Record<string, unknown>]>)('rejects malformed %s before input: %j', async (name, args) => {
    await expect(execute(name, args)).rejects.toThrow()
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('retains negative monitor coordinates and rounds valid fractional positions', async () => {
    await execute('os_click', { x: -1700.6, y: 80.4, button: 'right' })

    expect(mocks.invoke).toHaveBeenCalledWith('mouse_click', {
      payload: { button: 'right', x: -1701, y: 80, double: false },
    })
  })
})
