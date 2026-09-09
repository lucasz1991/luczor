import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  policy: vi.fn(),
  codex: vi.fn(),
  claude: vi.fn(),
  catalog: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/services/repositoryGraph', () => ({ getRepositoryExternalPolicy: mocks.policy }))
vi.mock('@/services/agents/codexAgent', () => ({
  getCodexRuntimeStatus: mocks.codex,
  getCodexModelCapabilities: mocks.catalog,
}))
vi.mock('@/services/agents/claudeAgent', () => ({
  getClaudeRuntimeStatus: mocks.claude,
  CLAUDE_CAPABILITIES: { revision: 'documented', models: [] },
}))
import { readWorkflowAgentAvailability } from '@/services/workflows/agentSelection'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.invoke.mockResolvedValue({
    manifestAvailable: true,
    state: 'ready',
    activeModelId: 'local',
    privatePayload: 'excluded',
  })
  mocks.policy.mockResolvedValue('ask')
  mocks.codex.mockResolvedValue({ available: true })
  mocks.claude.mockResolvedValue({ available: true, cliVersion: '2.1.266' })
  mocks.catalog.mockResolvedValue({ revision: 'cache', source: 'codex-cache', models: [] })
})
afterEach(() => vi.useRealTimers())

describe('bounded workflow adapter availability', () => {
  it('uses read-only status/catalog calls, never starts a CLI or local model and keeps auth unknown', async () => {
    const result = await readWorkflowAgentAvailability(new AbortController().signal)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('local_model_status')
    expect(mocks.codex).toHaveBeenCalledOnce()
    expect(mocks.claude).toHaveBeenCalledOnce()
    expect(result.local).toEqual({ manifestAvailable: true, state: 'ready', activeModelId: 'local' })
    expect(JSON.stringify(result)).not.toContain('privatePayload')
    expect(result.codex).not.toHaveProperty('authenticated')
  })
  it('bounds missing IPC replies without enabling an external route', async () => {
    vi.useFakeTimers()
    mocks.codex.mockReturnValue(new Promise(() => {}))
    const result = readWorkflowAgentAvailability(new AbortController().signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toMatchObject({ message: 'workflow_agent_availability_timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops waiting immediately on workflow cancellation and suppresses late metadata', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let resolve!: (value: unknown) => void
    mocks.codex.mockReturnValue(
      new Promise(done => {
        resolve = done
      })
    )
    const result = readWorkflowAgentAvailability(controller.signal).catch(error => error)
    controller.abort(new DOMException('cancelled', 'AbortError'))
    expect(await result).toMatchObject({ name: 'AbortError' })
    resolve({ available: true })
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('fails closed on unavailable external policy and never guesses endpoint health', async () => {
    mocks.policy.mockRejectedValue(new Error('unavailable'))
    mocks.codex.mockRejectedValue(new Error('unavailable'))
    const result = await readWorkflowAgentAvailability(new AbortController().signal)
    expect(result.externalPolicy).toBe('deny')
    expect(result.codex.available).toBe(false)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('local_model_status')
  })
})
