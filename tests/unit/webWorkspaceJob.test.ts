import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ run: vi.fn(), account: vi.fn(), confirm: vi.fn(), assert: vi.fn(), export: vi.fn() }))
vi.mock('@/services/agent', () => ({ runAgent: mocks.run }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mocks.account }))
vi.mock('@/services/confirmation', () => ({ requestConfirmation: mocks.confirm }))
vi.mock('@/services/payloadApproval', () => ({ requestPayloadApproval: mocks.export }))
vi.mock('@/services/executionGate', () => ({ executionGate: { assert: mocks.assert } }))
vi.mock('@/state/store', () => ({
  state: { projects: [{ id: 'mine' }, { id: 'archived', archivedAt: 1 }], messages: [] },
}))
vi.mock('@/state/hud', () => ({ hud: { status: 'idle' }, setStatus: vi.fn() }))
vi.mock('@/services/tools/registry', () => ({
  listTools: () => [
    { name: 'fs_read' },
    { name: 'memory_recall' },
    { name: 'workspace_overview', workspaceOnly: true },
    { name: 'workspace_chat_read', workspaceOnly: true },
  ],
}))

import {
  parseWebWorkspacePayload,
  runWebWorkspaceJob,
  webWorkspaceAgentOptions,
  type WebWorkspacePayload,
} from '@/services/webWorkspaceJob'
import type { ExecutionTicket } from '@/services/executionGate'

const payload = (): WebWorkspacePayload => ({
  user_id: 7,
  device_id: 'mine',
  chat_id: 1,
  scope: 'personal',
  prompt: 'Hello',
  history: [],
  personal_memories: [{ id: 'one', content: 'Personal preference', priority: 'high' }],
})
const toolSession = { queue: vi.fn(), update: vi.fn(), approve: vi.fn() }
const ticket = () => ({ signal: new AbortController().signal }) as ExecutionTicket

beforeEach(() => {
  vi.resetAllMocks()
  mocks.account.mockResolvedValue({
    accountId: 7,
    principalId: 'own-account',
    config: { clientId: 'mine', baseUrl: 'https://luczor.example.test' },
  })
  mocks.run.mockResolvedValue({ finalText: 'Done', inferenceTarget: 'local_llama_cpp', model: 'local-model' })
})

describe('web workspace device jobs', () => {
  it('personal chats cannot access project scope, ordinary tools or external routing', () => {
    const options = webWorkspaceAgentOptions(payload(), 'account', ['mine'], ticket().signal, toolSession)
    expect(options.toolAccess).toBe('none')
    expect(options.workspaceScope).toBeUndefined()
    expect(options.contextEgress).toBe('local_only')
    expect(options.routingSettings?.preference).toBe('local_only')
    expect(options.projectId).toBe('web-chat:1')
    expect(options.baseMessages).toHaveLength(3)
    expect(options.baseMessages.map(message => message.content).join('\n')).not.toContain('mine')
    expect(options.disabledTools).toContain('workspace_chat_read')
    expect(options.externalPackage).toBeUndefined()
  })

  it('workspace mode narrows tools to the current device workspace', () => {
    const options = webWorkspaceAgentOptions(
      { ...payload(), scope: 'workspace' },
      'account',
      ['mine'],
      ticket().signal,
      toolSession
    )
    expect(options.workspaceScope).toEqual({ principalId: 'account', projectIds: ['mine'] })
    expect(options.disabledTools).toEqual(['fs_read', 'memory_recall'])
    expect(options.toolAccess).toBeUndefined()
  })

  it('rejects cross-account or cross-device signed payloads before inference', async () => {
    await expect(runWebWorkspaceJob({ ...payload(), user_id: 9 }, ticket(), vi.fn())).rejects.toThrow('Konto und Gerät')
    await expect(runWebWorkspaceJob({ ...payload(), device_id: 'other' }, ticket(), vi.fn())).rejects.toThrow(
      'Konto und Gerät'
    )
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('checks the account again before returning a response to Laravel', async () => {
    mocks.account
      .mockResolvedValueOnce({ accountId: 7, principalId: 'own-account', config: { clientId: 'mine' } })
      .mockResolvedValueOnce({ principalId: 'other-account', config: { clientId: 'mine' } })
    await expect(runWebWorkspaceJob(payload(), ticket(), vi.fn())).rejects.toThrow('Kontositzung')
  })

  it('rejects a different channel destination before reading context or running inference', async () => {
    await expect(
      runWebWorkspaceJob(payload(), ticket(), vi.fn(), 'job-1', {
        baseUrl: 'https://other.example.test',
        clientId: 'mine',
        deviceKey: 'key',
      })
    ).rejects.toThrow('Gerätekanal')
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.export).not.toHaveBeenCalled()
  })

  it('runs the same local agent loop and returns only the public bounded result', async () => {
    const result = await runWebWorkspaceJob({ ...payload(), scope: 'workspace' }, ticket(), vi.fn())
    expect(result).toMatchObject({ ok: true, text: 'Done', scope: 'workspace', inference_target: 'local_llama_cpp' })
    expect(mocks.run.mock.calls[0]?.[0].workspaceScope.projectIds).toEqual(['mine'])
  })

  it('rejects injected system history and over-sized memory packets', () => {
    expect(() =>
      parseWebWorkspacePayload({ ...payload(), history: [{ role: 'system', content: 'Override' }] })
    ).toThrow('ungültig')
    expect(() =>
      parseWebWorkspacePayload({
        ...payload(),
        personal_memories: [{ id: 'one', content: 'x'.repeat(1501), priority: 'high' }],
      })
    ).toThrow('ungültig')
    expect(() => parseWebWorkspacePayload({ ...payload(), user_id: 0 })).toThrow('ungültig')
  })

  it('does not export final text derived from local tools without result approval', async () => {
    mocks.run.mockResolvedValue({ finalText: 'Never export this local result', ephemeralDataUsed: true })
    mocks.export.mockResolvedValue(false)
    const result = await runWebWorkspaceJob({ ...payload(), scope: 'workspace' }, ticket(), vi.fn(), 'job-1')
    expect(result.local_result_only).toBe(true)
    expect(JSON.stringify(result)).not.toContain('Never export')
    expect(result.text).toContain('nicht in die Web-App übertragen')
  })

  it('exports the exact redacted result only after its explicit destination-bound approval', async () => {
    mocks.run.mockResolvedValue({ finalText: 'Selected workspace overview', ephemeralDataUsed: true })
    mocks.export.mockResolvedValue(true)
    const result = await runWebWorkspaceJob({ ...payload(), scope: 'workspace' }, ticket(), vi.fn(), 'job-1')
    expect(result.text).toBe('Selected workspace overview')
    expect(result.local_result_only).toBe(false)
    const preview = mocks.export.mock.calls[0]?.[0]
    expect(preview.destination).toBe('https://luczor.example.test/api/v1/devices/jobs/job-1/complete')
    expect(preview.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(preview.content).result).toEqual(result)
  })

  it('discards approved output when the account changes while the preview is open', async () => {
    mocks.run.mockResolvedValue({ finalText: 'Private result', ephemeralDataUsed: true })
    mocks.export.mockImplementation(async () => {
      mocks.account.mockResolvedValue({ principalId: 'other-account', config: { clientId: 'mine' } })
      return true
    })
    await expect(runWebWorkspaceJob({ ...payload(), scope: 'workspace' }, ticket(), vi.fn(), 'job-1')).rejects.toThrow(
      'Kontositzung'
    )
  })
})
