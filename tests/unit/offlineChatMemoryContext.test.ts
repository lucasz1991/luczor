import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  files: new Map<string, Map<string, unknown>>(),
  account: vi.fn(),
  workspacePrincipal: vi.fn(),
  repository: vi.fn(),
  fetch: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async (filename: string) => {
      let values = mocks.files.get(filename)
      if (!values) {
        values = new Map()
        mocks.files.set(filename, values)
      }
      return {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => values.set(key, value),
        delete: async (key: string) => values.delete(key),
        save: async () => undefined,
      }
    },
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'memory_key_get_or_create') return '12'.repeat(32)
    throw new Error(`Unexpected command ${command}`)
  },
}))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mocks.account }))
vi.mock('@/services/projectWorkspace', () => ({ resolveWorkspacePrincipalId: mocks.workspacePrincipal }))
vi.mock('@/services/repositoryGraph', () => ({ buildLocalRepositoryContext: mocks.repository }))
vi.mock('@/services/memory/preparedContext', () => ({ preparedContextFragments: async () => [] }))

import { captureAutomaticChatMemory } from '@/services/memory/chatContext'
import { luczorMemory } from '@/services/memory/luczorMemory'
import { buildLocalPromptContextDetails } from '@/services/contextController'

// Exercise the actual App admission binding with the actual memory capture/retrieval facade.
const app = readFileSync('src/App.vue', 'utf8')
const start = app.indexOf('captured.principalId = await resolveWorkspacePrincipalId()')
const end = app.indexOf('executionGate.assert(execution)', start)
const binding = ts.transpileModule(
  `async function capturePrincipal() {
  const captured = { principalId: '', memoryPrincipalId: '' }
  ${app.slice(start, end)}
  return captured
}
capturePrincipal`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText
const capturePrincipal = () =>
  (
    runInNewContext(binding, {
      resolveWorkspacePrincipalId: mocks.workspacePrincipal,
      getVerifiedAccountSnapshot: mocks.account,
    }) as () => Promise<{ principalId: string; memoryPrincipalId: string }>
  )()

describe('offline App memory contract', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.files.clear()
    mocks.account.mockResolvedValue(null)
    mocks.workspacePrincipal.mockResolvedValue('device:v1:workspace-key-hash')
    mocks.repository.mockResolvedValue(null)
    vi.stubGlobal('fetch', mocks.fetch)
  })

  it('captures and recalls through real encrypted memory while graph ownership stays device-key-bound', async () => {
    const principal = await capturePrincipal()
    expect(principal).toEqual({ principalId: 'device:v1:workspace-key-hash', memoryPrincipalId: 'device-local' })
    expect(
      await captureAutomaticChatMemory({
        projectId: 'offline-project',
        conversationId: 'offline-chat',
        expectedPrincipalId: principal.memoryPrincipalId,
        message: {
          id: 'actual-user',
          role: 'user',
          content: 'Die Laravel Queue benötigt einen Neustart nach dem Release.',
          ts: 100,
        },
        phase: 'submitted',
      })
    ).toBe(1)
    const context = await buildLocalPromptContextDetails(
      'offline-project',
      'Laravel Queue',
      5,
      'chat.general',
      'chat',
      { conversationId: 'offline-chat' }
    )
    expect(mocks.repository.mock.calls[0]?.[0]).toBe(principal.principalId)
    expect(context.memoryDiagnostics?.conversationExcerpts).toBe(1)
    const excerpt = context.fragments?.find(fragment => fragment.id.startsWith('session-memory-candidate:'))
    expect(excerpt).toMatchObject({ source: 'history', egress: 'local_only', trust: 'untrusted_data' })
    expect(JSON.parse(excerpt!.content)).toMatchObject({
      status: 'candidate',
      sources: [{ messageId: 'actual-user', role: 'user' }],
    })
    expect(typeof mocks.files.get('luczor.memory.json')?.get('state_v3_encrypted')).toBe('string')
    expect(
      await luczorMemory.recallSessionCandidates({
        projectId: 'offline-project',
        sessionId: 'offline-chat',
        query: 'Laravel',
        expectedPrincipalId: principal.principalId,
      })
    ).toEqual([])
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('does not treat failed account verification as permission to capture into the offline namespace', async () => {
    mocks.account.mockRejectedValue(new Error('account verification rejected'))
    await expect(capturePrincipal()).rejects.toThrow('account verification rejected')
    expect(mocks.files.size).toBe(0)
  })

  it('keeps the workspace scope check even though memory has a stable offline namespace', async () => {
    mocks.workspacePrincipal.mockResolvedValueOnce('device:v1:before').mockResolvedValueOnce('device:v1:after')
    await expect(capturePrincipal()).rejects.toThrow('Benutzerkonto')
    mocks.workspacePrincipal.mockResolvedValueOnce('device:v1:before').mockResolvedValueOnce('device:v1:after')
    await expect(
      buildLocalPromptContextDetails('offline-project', 'Laravel', 5, 'chat.general', 'chat', {
        conversationId: 'offline-chat',
      })
    ).rejects.toThrow('Konto')
  })
})
