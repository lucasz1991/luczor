import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const app = readFileSync('src/App.vue', 'utf8')
const start = app.indexOf('async function rememberExchange(')
const end = app.indexOf('/* -------------------------------------------------', start)
const compiled = ts.transpileModule(`${app.slice(start, end)}\nrememberExchange`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function capture(autoRemember = true) {
  const remember = vi.fn()
  const messages = [
    { id: 'actual-user', role: 'user', content: 'Eine echte Nutzerentscheidung.', ts: 10 },
    { id: 'previous-answer', role: 'assistant', content: 'Vorheriges Ergebnis.', ts: 20 },
    { id: 'answer', role: 'assistant', content: 'Die ausgeführte Entscheidung.', ts: 30 },
  ]
  const read = vi.fn(() => messages)
  const fn = runInNewContext(compiled, {
    getMemoryPrefs: async () => ({ autoRemember }),
    executionGate: { assert: vi.fn() },
    mutations: { getConversationMessages: read },
    luczorMemory: { remember },
    safeTrim: (value: unknown) => (typeof value === 'string' ? value.trim() : ''),
    refreshMemoryCandidates: async () => undefined,
    refreshStatus: async () => undefined,
    console,
  }) as (...args: unknown[]) => Promise<void>
  return { remember, read, fn }
}

describe('App chat memory provenance integration', () => {
  it('captures the submitted conversation and actual message roles instead of current UI state', async () => {
    const { fn, read, remember } = capture()
    await fn('p1', 'chat-1', 'actual-user', 'answer', 'account-1', { scope: { runId: 'run-1' } })
    expect(read).toHaveBeenCalledWith('p1', 'chat-1')
    expect(remember.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        content: 'Eine echte Nutzerentscheidung.',
        source: 'user',
        sourceRef: 'actual-user',
        expectedPrincipalId: 'account-1',
        sessionId: 'chat-1',
        origin: { conversationId: 'chat-1', runId: 'run-1', messageId: 'actual-user', role: 'user', observedAt: 10 },
      }),
      expect.objectContaining({
        content: 'Die ausgeführte Entscheidung.',
        source: 'assistant',
        sourceRef: 'answer',
        expectedPrincipalId: 'account-1',
        origin: { conversationId: 'chat-1', runId: 'run-1', messageId: 'answer', role: 'assistant', observedAt: 30 },
      }),
    ])
  })

  it.each([undefined, 'previous-answer'])(
    'never manufactures a user source for an autonomous goal boundary %s',
    async boundary => {
      const { fn, remember } = capture()
      await fn('p1', 'chat-1', boundary, 'answer', 'account-1', { scope: { runId: 'run-1' } })
      expect(remember).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ source: 'assistant', sourceRef: 'answer' })
      )
    }
  )

  it('preserves a disabled auto-capture preference', async () => {
    const { fn, remember } = capture(false)
    await fn('p1', 'chat-1', 'actual-user', 'answer', 'account-1', {})
    expect(remember).not.toHaveBeenCalled()
  })
})
