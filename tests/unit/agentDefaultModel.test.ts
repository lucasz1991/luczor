import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
import { resolveAgentDefaultModel } from '@/services/agents/defaultModel'
const project = {
  principalId: 'principal',
  projectId: 'project',
  projectName: 'Synthetic',
  rootPath: 'E:\\test',
  workspaceUpdatedAt: 7,
}
const confirmed = {
  status: 'confirmed',
  model: 'actual-configured-model',
  source: 'codex-config',
  revision: 'a'.repeat(64),
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.invoke.mockResolvedValue(confirmed)
})
afterEach(() => vi.useRealTimers())
describe('project-bound native default model resolution', () => {
  it('requests only the exact identity/workspace metadata and returns only allowlisted model evidence', async () => {
    mocks.invoke.mockResolvedValue({ ...confirmed, privateData: 'must not escape' })
    expect(await resolveAgentDefaultModel('codex', project)).toEqual({
      model: confirmed.model,
      revision: confirmed.revision,
      source: confirmed.source,
    })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('agent_default_model_resolve', {
      payload: {
        adapterId: 'codex',
        principalId: 'principal',
        projectId: 'project',
        expectedRootPath: 'E:\\test',
        expectedWorkspaceUpdatedAt: 7,
      },
    })
  })
  it.each([
    { status: 'unconfirmed' },
    { model: 'default', status: 'unconfirmed' },
    { model: '--flag unsafe' },
    { revision: 'stale' },
    { source: 'private/path' },
    { model: null },
  ])('rejects absent or malformed configuration evidence: %j', async changed => {
    mocks.invoke.mockResolvedValue({ ...confirmed, ...changed })
    await expect(resolveAgentDefaultModel('claude', project)).rejects.toThrow('agent_default_model_unconfirmed')
  })
  it('rejects an unbound project without native probing', async () => {
    await expect(resolveAgentDefaultModel('codex', { ...project, rootPath: undefined })).rejects.toThrow(
      'scope_required'
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it('preserves only the documented Claude context suffix instead of changing the configured context', async () => {
    mocks.invoke.mockResolvedValue({ ...confirmed, model: 'claude-opus-5[1m]', source: 'claude-context' })
    expect(await resolveAgentDefaultModel('claude', project)).toMatchObject({ model: 'claude-opus-5[1m]' })
    await expect(resolveAgentDefaultModel('codex', project)).rejects.toThrow('unconfirmed')
    mocks.invoke.mockResolvedValue({ ...confirmed, model: 'claude-opus-5[2m]' })
    await expect(resolveAgentDefaultModel('claude', project)).rejects.toThrow('unconfirmed')
  })
  it('bounds a missing native response without choosing a fallback model', async () => {
    vi.useFakeTimers()
    mocks.invoke.mockReturnValue(new Promise(() => {}))
    const result = resolveAgentDefaultModel('codex', project).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(18_000)
    expect(await result).toMatchObject({ message: 'agent_default_model_timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows the full native 15s probe and 2s cleanup budget before applying its own deadline', async () => {
    vi.useFakeTimers()
    mocks.invoke.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(confirmed), 17_000)))
    const result = resolveAgentDefaultModel('codex', project)
    await vi.advanceTimersByTimeAsync(17_000)
    await expect(result).resolves.toEqual({
      model: confirmed.model,
      revision: confirmed.revision,
      source: confirmed.source,
    })
    expect(vi.getTimerCount()).toBe(0)
  })
})
