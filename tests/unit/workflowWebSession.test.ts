import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkflowWebSession } from '@/services/workflows/webSession'

const state = {
  workflow: { id: 7, version: 1 },
  urls: { runControls: '/dashboard/workflows/7/run-controls', operation: '/dashboard/workflows/7/operations' },
}
const storage = new Map<string, string>()
const fetchMock = vi.fn()
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
let csrf = 'test-session-csrf'
beforeEach(() => {
  storage.clear()
  fetchMock.mockReset()
  csrf = 'test-session-csrf'
  vi.stubGlobal('window', { location: { origin: 'https://workflow.test' } })
  vi.stubGlobal('document', { querySelector: () => (csrf ? { content: csrf } : null) })
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('session-bound web workflow run controls', () => {
  it('roundtrips persistent device targets through versioned save and rejects invalid selectors before PUT', async () => {
    const definition = {
      steps: [
        {
          key: 'read',
          type: 'browser.read',
          payload: {},
          device_target: { kind: 'capability', task_type: 'browser.read', task_version: 1 },
        },
      ],
    }
    const editorState = {
      ...state,
      catalog: [{ key: 'browser.read', runner: 'client' }],
      urls: { ...state.urls, save: '/dashboard/workflows/7' },
    }
    fetchMock.mockImplementation(async (_path, options) =>
      json(options.method === 'PUT' ? { version: 2, definition } : editorState)
    )
    const session = createWorkflowWebSession('/dashboard/workflows/7/editor-state')
    await session.refresh()
    await expect(
      session.mutate('save', { expected_version: 1, definition_json: JSON.stringify(definition) })
    ).resolves.toMatchObject({ version: 2, definition })
    const [, options] = fetchMock.mock.calls.find(([, options]) => options.method === 'PUT')!
    expect(JSON.parse(options.body)).toMatchObject({ expected_version: 1, definition_json: JSON.stringify(definition) })
    fetchMock.mockClear()
    definition.steps[0]!.device_target.task_version = 2
    await expect(
      session.mutate('save', { expected_version: 2, definition_json: JSON.stringify(definition) })
    ).rejects.toThrow('Version 1')
    expect(fetchMock).not.toHaveBeenCalled()
    session.dispose()
  })
  it('sends same-origin CSRF with an operation identity and never fabricates device authority', async () => {
    fetchMock.mockImplementation(async (_path, options) =>
      options.method === 'POST'
        ? json({ data: { run: { status: 'running', budget_state: { boundary_stop: { status: 'pending' } } } } })
        : json(state)
    )
    const session = createWorkflowWebSession('/dashboard/workflows/7/editor-state')
    await session.refresh()
    const result = await session.mutate('runControls', {
      run_id: '11111111-1111-4111-8111-111111111111',
      action: 'stop_after_step',
    })
    expect(result).toMatchObject({
      data: { run: { status: 'running', budget_state: { boundary_stop: { status: 'pending' } } } },
    })
    const [, options] = fetchMock.mock.calls.find(([, options]) => options.method === 'POST')!
    expect(options).toMatchObject({ credentials: 'same-origin', redirect: 'error', headers: { 'X-CSRF-TOKEN': csrf } })
    const body = JSON.parse(options.body)
    expect(body.operation_id).toMatch(/^[a-f0-9-]{36}$/u)
    expect(body).not.toHaveProperty('device_id')
    expect(body).not.toHaveProperty('local_approved')
    session.dispose()
  })
  it('recovers a lost stop reply before retrying and sends only one stop POST', async () => {
    let operationId = ''
    fetchMock.mockImplementation(async (path, options) => {
      if (options.method === 'POST') {
        operationId = JSON.parse(options.body).operation_id
        throw new Error('Lost after commit')
      }
      if (path.endsWith(`/operations/${operationId}`))
        return json({ status: 'completed', response: { data: { run: { status: 'running' } } } })
      return json(state)
    })
    const session = createWorkflowWebSession('/dashboard/workflows/7/editor-state')
    await session.refresh()
    const args = { run_id: '11111111-1111-4111-8111-111111111111', action: 'stop_after_step' }
    await expect(session.mutate('runControls', args)).rejects.toThrow('unklar')
    await expect(session.mutate('runControls', args)).resolves.toMatchObject({ data: { run: { status: 'running' } } })
    expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1)
    expect([...storage.values()].join('')).not.toContain(csrf)
    session.dispose()
  })
  it('does not post when CSRF is missing or the account session was invalidated', async () => {
    fetchMock.mockResolvedValue(json(state))
    const session = createWorkflowWebSession('/dashboard/workflows/7/editor-state')
    await session.refresh()
    csrf = ''
    fetchMock.mockImplementation(async () => json(state))
    await expect(session.mutate('runControls', { run_id: 'one', action: 'cancel' })).rejects.toThrow()
    expect(fetchMock.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false)
    csrf = 'test'
    fetchMock.mockImplementation(async () => json({}, 401))
    await expect(session.mutate('runControls', { run_id: 'two', action: 'cancel' })).rejects.toThrow('Benutzersitzung')
    expect(fetchMock.mock.calls.some(([, options]) => options.method === 'POST')).toBe(false)
    session.dispose()
  })
})
