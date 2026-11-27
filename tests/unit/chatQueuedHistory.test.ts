import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Exercise the actual transcript boundary of executeChatTurn in App.vue.
const app = readFileSync('src/App.vue', 'utf8')
const start = app.indexOf('const boundary = conversationMessages.findIndex(')
const end = app.indexOf('// Device-local answers remain available to the next local request.', start)
const compiled = ts.transpileModule(
  `function historyFor(conversationMessages, captured, assistant) {\n${app.slice(start, end)}\nreturn fullHistory\n}\nhistoryFor`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
).outputText
const historyFor = runInNewContext(compiled, {}) as (
  messages: Message[],
  captured: { userMessageId: string },
  assistant: { id: string }
) => Message[]

type Message = { id: string; role: 'user' | 'assistant' | 'tool'; ts: number; meta: { runId?: string } }
const message = (id: string, role: Message['role'], ts: number, runId?: string): Message => ({
  id,
  role,
  ts,
  meta: runId ? { runId } : {},
})
const ids = (messages: Message[]) => messages.map(item => item.id)

describe('chat history of a queued turn', () => {
  it('keeps the ordinary order unchanged and leaves this turn’s placeholder and later requests out', () => {
    const messages = [
      message('u1', 'user', 1, 'run-1'),
      message('a1', 'assistant', 2, 'run-1'),
      message('u2', 'user', 3, 'run-2'),
      message('a2', 'assistant', 4, 'run-2'),
      message('u3', 'user', 5, 'run-3'),
    ]
    expect(ids(historyFor(messages, { userMessageId: 'u2' }, { id: 'a2' }))).toEqual(['u1', 'a1', 'u2'])
  })

  it('puts the answer of a run that waited in the queue back behind its own request', () => {
    // Run 1 was live while the user queued u2 and u3; run 2 stamped a2 only when it started.
    const messages = [
      message('u1', 'user', 1, 'run-1'),
      message('a1', 'assistant', 2, 'run-1'),
      message('u2', 'user', 3, 'run-2'),
      message('u3', 'user', 4, 'run-3'),
      message('a2', 'assistant', 5, 'run-2'),
      message('t2', 'tool', 6, 'run-2'),
      message('a3', 'assistant', 7, 'run-3'),
    ]
    expect(ids(historyFor(messages, { userMessageId: 'u3' }, { id: 'a3' }))).toEqual(['u1', 'a1', 'u2', 'a2', 'u3'])
  })

  it('does not invent a transcript without a boundary message', () => {
    const messages = [message('a1', 'assistant', 1, 'run-1')]
    expect(historyFor(messages, { userMessageId: '' }, { id: 'a2' })).toEqual([])
  })
})
