import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, PendingToolCall } from '@/state/types'

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn(async () => storage) } }))

import { DEFAULT_STATE } from '@/state/defaults'
import { loadAppState, saveAppState, saveAppStateStrict, stateForPersistence } from '@/services/persistence'
import { getTool } from '@/services/tools/registry'

function pending(name: string, status: PendingToolCall['status'] = 'proposed'): PendingToolCall {
  return {
    id: `call-${name}`,
    projectId: 'default',
    name,
    args: { text: 'LOCAL_OBSERVATION_SECRET', path: 'private.md' },
    requiresApproval: true,
    status,
    createdAt: 1,
    updatedAt: 1,
  }
}

function appState(...calls: PendingToolCall[]): AppState {
  const state = structuredClone(DEFAULT_STATE)
  state.pending.toolCallsByProject = { default: calls }
  return state
}

describe('ephemeral tool argument persistence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    storage.save.mockResolvedValue(undefined)
  })

  it('restores interrupted public commentary without leaving a running indicator', async () => {
    const state = appState()
    state.messages = [
      {
        id: 'answer',
        projectId: 'default',
        role: 'assistant',
        content: 'Erstes Teilstück',
        ts: 1,
        createdAt: 1,
        parsed: null,
        visibility: 'visible',
        meta: {
          isLoading: true,
          dataHandling: 'ephemeral',
          serverSpeechAllowed: false,
          commentary: [
            {
              id: 'round-1',
              round: 1,
              content: 'Zwischenstand bleibt erhalten.',
              createdAt: 1,
              serverSpeechAllowed: true,
            },
          ],
          activity: {
            startedAt: 1,
            status: 'running',
            steps: [{ id: 'round-2-receiving', label: 'Antwort wird geschrieben', status: 'running' }],
          },
        },
      },
    ]
    storage.get.mockResolvedValue(state)
    const restored = await loadAppState()
    expect(restored.messages[0]?.content).toBe('Erstes Teilstück')
    expect(restored.messages[0]?.meta.commentary?.[0]?.content).toBe('Zwischenstand bleibt erhalten.')
    expect(restored.messages[0]?.meta).toMatchObject({
      isLoading: false,
      serverSpeechAllowed: false,
      dataHandling: 'ephemeral',
      activity: { status: 'canceled', steps: [{ status: 'canceled' }] },
    })
    expect(state.messages[0]?.meta.activity?.status).toBe('running')
  })

  it('persists redacted real file/desktop tool arguments while preserving live approval details', async () => {
    const active = appState(pending('fs_write'), pending('os_type_text'), pending('agent_dispatch'))
    for (const call of active.pending.toolCallsByProject.default!) {
      const tool = getTool(call.name)
      expect(tool?.dataHandling === 'ephemeral' || tool?.risk === 'critical').toBe(true)
    }

    await saveAppState(active)

    const saved = storage.set.mock.calls[0]![1] as AppState
    expect(JSON.stringify(saved)).not.toContain('LOCAL_OBSERVATION_SECRET')
    expect(JSON.stringify(saved)).not.toContain('private.md')
    for (const call of saved.pending.toolCallsByProject.default!) {
      expect(call).toMatchObject({ args: { redacted: true }, status: 'canceled', dataHandling: 'ephemeral' })
    }
    for (const call of active.pending.toolCallsByProject.default!) {
      expect(call).toMatchObject({ args: { text: 'LOCAL_OBSERVATION_SECRET' }, status: 'proposed' })
    }
    expect(storage.save).toHaveBeenCalledOnce()
  })

  it('propagates a strict app-state commit failure to transactional callers', async () => {
    storage.save.mockRejectedValueOnce(new Error('disk full'))

    await expect(saveAppStateStrict(appState())).rejects.toThrow('disk full')
  })

  it('serializes strict snapshots so an older delayed save cannot overwrite a newer project commit', async () => {
    let releaseFirst!: () => void
    const firstSave = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    storage.save.mockImplementationOnce(() => firstSave).mockResolvedValueOnce(undefined)
    const beforeProject = appState()
    const withProject = appState()
    withProject.projects.push({
      ...structuredClone(withProject.projects[0]!),
      id: 'project-new',
      name: 'Neues Projekt',
      createdAt: 2,
      updatedAt: 2,
    })

    const older = saveAppStateStrict(beforeProject)
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledOnce())
    const durableProject = saveAppStateStrict(withProject)
    await Promise.resolve()

    expect(storage.set).toHaveBeenCalledOnce()
    releaseFirst()
    await Promise.all([older, durableProject])

    expect(storage.set).toHaveBeenCalledTimes(2)
    expect((storage.set.mock.calls[1]![1] as AppState).projects).toContainEqual(
      expect.objectContaining({ id: 'project-new' })
    )
  })

  it('scrubs legacy arguments and result errors on reload and updates the stored snapshot', async () => {
    const call = pending('agent_dispatch', 'failed')
    call.result = {
      toolCallId: call.id,
      name: call.name,
      ok: false,
      output: { stdout: 'LOCAL_OBSERVATION_SECRET' },
      error: 'LOCAL_ERROR_SECRET',
      ts: 2,
    }
    storage.get.mockResolvedValue(appState(call))

    const restored = await loadAppState()

    expect(JSON.stringify(restored)).not.toMatch(/LOCAL_OBSERVATION_SECRET|LOCAL_ERROR_SECRET|private\.md/)
    expect(restored.pending.toolCallsByProject.default![0]).toMatchObject({
      status: 'failed',
      args: { redacted: true },
      result: { ok: false, output: { redacted: true } },
    })
    expect(storage.set).toHaveBeenCalledExactlyOnceWith('app_state_v1', restored)
    expect(storage.save).toHaveBeenCalledOnce()
  })

  it('returns a redacted reload even when cleanup cannot be saved yet', async () => {
    storage.get.mockResolvedValue(appState(pending('os_type_text', 'executing')))
    storage.save.mockRejectedValue(new Error('storage unavailable'))

    const restored = await loadAppState()

    expect(restored.pending.toolCallsByProject.default![0]).toMatchObject({
      name: 'os_type_text',
      status: 'canceled',
      args: { redacted: true },
    })
    expect(JSON.stringify(restored)).not.toContain('LOCAL_OBSERVATION_SECRET')
  })

  it('preserves known syncable project history but fails closed for unknown and historically ephemeral tools', () => {
    const normal = pending('project_set_summary', 'executed')
    normal.args = { summary: 'Nutzerfreigegebener Projektstand' }
    const historical = { ...pending('project_set_summary', 'executed'), dataHandling: 'ephemeral' as const }
    const unknown = pending('removed_private_tool', 'approved')

    const saved = stateForPersistence(appState(normal, historical, unknown))

    expect(saved.pending.toolCallsByProject.default![0]).toEqual(normal)
    expect(saved.pending.toolCallsByProject.default![1]).toMatchObject({
      status: 'executed',
      args: { redacted: true },
    })
    expect(saved.pending.toolCallsByProject.default![2]).toMatchObject({ status: 'canceled', args: { redacted: true } })
    expect(JSON.stringify(saved)).not.toContain('LOCAL_OBSERVATION_SECRET')
  })
})
