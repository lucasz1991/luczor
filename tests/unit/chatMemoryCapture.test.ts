import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { canPersistData } from '@/services/runs/dataPolicy'

const app = readFileSync('src/App.vue', 'utf8')
const start = app.indexOf('async function rememberExchange(')
const end = app.indexOf('/* -------------------------------------------------', start)
const compiled = ts.transpileModule(`${app.slice(start, end)}\nrememberExchange`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function capture(autoRemember = true) {
  const remember = vi.fn()
  const messages = [
    {
      id: 'actual-user',
      role: 'user',
      content: 'Eine echte Nutzerentscheidung.',
      ts: 10,
      meta: {} as Record<string, unknown>,
    },
    {
      id: 'previous-answer',
      role: 'assistant',
      content: 'Vorheriges Ergebnis.',
      ts: 20,
      meta: {} as Record<string, unknown>,
    },
    {
      id: 'answer',
      role: 'assistant',
      content: 'Die ausgeführte Entscheidung.',
      ts: 30,
      meta: {} as Record<string, unknown>,
    },
  ]
  const read = vi.fn(() => messages)
  const fn = runInNewContext(compiled, {
    canPersistData,
    getMemoryPrefs: async () => ({ autoRemember }),
    executionGate: { assert: vi.fn() },
    mutations: { getConversationMessages: read },
    captureAutomaticChatMemory: remember,
    safeTrim: (value: unknown) => (typeof value === 'string' ? value.trim() : ''),
    refreshMemoryCandidates: async () => undefined,
    refreshStatus: async () => undefined,
    console,
  }) as (...args: unknown[]) => Promise<void>
  return { remember, read, fn, messages }
}

describe('App chat memory provenance integration', () => {
  it('captures the submitted conversation and actual message roles instead of current UI state', async () => {
    const { fn, read, remember } = capture()
    await fn('p1', 'chat-1', 'actual-user', 'answer', 'account-1', { scope: { runId: 'run-1' } }, true)
    expect(read).toHaveBeenCalledWith('p1', 'chat-1')
    expect(remember.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        message: {
          id: 'actual-user',
          role: 'user',
          content: 'Eine echte Nutzerentscheidung.',
          ts: 10,
          ephemeral: false,
        },
        expectedPrincipalId: 'account-1',
        conversationId: 'chat-1',
        runId: 'run-1',
        phase: 'completed',
      }),
      expect.objectContaining({
        message: {
          id: 'answer',
          role: 'assistant',
          content: 'Die ausgeführte Entscheidung.',
          ts: 30,
          ephemeral: false,
        },
        expectedPrincipalId: 'account-1',
        conversationId: 'chat-1',
        runId: 'run-1',
        phase: 'completed',
      }),
    ])
  })

  it.each([undefined, 'previous-answer'])(
    'never manufactures a user source for an autonomous goal boundary %s',
    async boundary => {
      const { fn, remember } = capture()
      await fn('p1', 'chat-1', boundary, 'answer', 'account-1', { scope: { runId: 'run-1' } }, true)
      expect(remember).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: expect.objectContaining({ role: 'assistant', id: 'answer' }) }),
        expect.objectContaining({ assertCurrent: expect.any(Function) })
      )
    }
  )

  it('preserves a disabled auto-capture preference', async () => {
    const { fn, remember } = capture(false)
    await fn('p1', 'chat-1', 'actual-user', 'answer', 'account-1', {})
    expect(remember).not.toHaveBeenCalled()
  })

  it.each([false, true])('preserves actual ephemeral flags and the assistant retention gate (%s)', async allowed => {
    const { fn, messages, remember } = capture()
    messages[0]!.meta.dataHandling = 'ephemeral'
    messages[2]!.meta.dataHandling = 'ephemeral'
    await fn('p1', 'chat-1', 'actual-user', 'answer', 'device-local', {}, allowed)
    expect(remember.mock.calls.map(([input]) => input.message.ephemeral)).toEqual([true, true])
    messages[0]!.meta = {}
    messages[2]!.meta = {}
    remember.mockClear()
    await fn('p1', 'chat-1', 'actual-user', 'answer', 'device-local', {}, allowed)
    expect(remember.mock.calls.map(([input]) => input.message.ephemeral)).toEqual([false, !allowed])
  })
  it('captures local-only assistant evidence while retaining its transfer restriction', async () => {
    const { fn, messages, remember } = capture()
    messages[2]!.meta = { dataHandling: 'ephemeral', retentionPolicy: 'local_only' }
    await fn('p1', 'chat-1', undefined, 'answer', 'device-local', {}, true)
    expect(remember.mock.calls[0]?.[0].message).toMatchObject({ ephemeral: false, dataPolicy: 'local_only' })
  })
})
