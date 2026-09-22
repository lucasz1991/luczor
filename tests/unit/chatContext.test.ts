import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildMemoryContextQuery,
  captureAutomaticChatMemory,
  planAutomaticChatCapture,
  sessionCandidateFragments,
  type AutomaticChatCapture,
} from '@/services/memory/chatContext'
import { captureMemoryMetadata } from '@/services/memory/memoryMetadata'
import type { MemoryRecord } from '@/services/memory/luczorMemory'

const mocks = vi.hoisted(() => ({ remember: vi.fn(), prefs: vi.fn() }))
vi.mock('@/services/memory/luczorMemory', async importOriginal => ({
  ...(await importOriginal<typeof import('@/services/memory/luczorMemory')>()),
  luczorMemory: {
    captureChatExcerpts: async (inputs: unknown[], assertCurrent?: () => void) => {
      for (const input of inputs) {
        assertCurrent?.()
        await mocks.remember(input)
      }
      return inputs.length
    },
  },
  getMemoryPrefs: mocks.prefs,
}))

const capture = (content: string, role: 'user' | 'assistant' = 'user'): AutomaticChatCapture => ({
  projectId: 'project-1',
  conversationId: 'chat-1',
  expectedPrincipalId: 'account-1',
  runId: 'run-1',
  phase: 'submitted',
  message: { id: 'real-message', role, content, ts: 100 },
})

describe('automatic conversational memory capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prefs.mockResolvedValue({ autoRemember: true, inject: true })
    mocks.remember.mockResolvedValue({})
  })

  it('captures useful original facts durably with exact offsets and actual user provenance', () => {
    const input = capture(
      'Ich bevorzuge Laravel für dieses Projekt.\n\nAlle Änderungen müssen separat getestet werden.'
    )
    const records = planAutomaticChatCapture(input)
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(record).toMatchObject({
        scope: 'project',
        projectId: 'project-1',
        sessionId: 'chat-1',
        expectedPrincipalId: 'account-1',
        source: 'user',
        sourceRef: 'real-message',
        writeIntent: 'automatic',
        retention: 'durable',
        visibility: 'private',
        origin: { messageId: 'real-message', conversationId: 'chat-1', runId: 'run-1', role: 'user', observedAt: 100 },
      })
      expect(
        input.message.content.slice(Number(record.provenance?.source_start), Number(record.provenance?.source_end))
      ).toBe(record.content)
    }
  })

  it('keeps assistant progress unconfirmed and does not import fenced tool/code payloads', () => {
    const input = capture(
      'Der Fehler im Parser wurde behoben.\n\n```json\n{"tool":"huge private source payload"}\n```\n\nDer Integrationstest bleibt noch offen.',
      'assistant'
    )
    const records = planAutomaticChatCapture(input)
    expect(records.map(record => record.content)).toEqual([
      'Der Fehler im Parser wurde behoben.',
      'Der Integrationstest bleibt noch offen.',
    ])
    expect(records.every(record => record.writeIntent === 'automatic' && record.source === 'assistant')).toBe(true)
  })

  it('bounds facts atomically and keeps a concrete late decision ahead of low value introductory prose', () => {
    const input = capture(
      [
        ...Array.from(
          { length: 12 },
          (_, i) => `Einleitende allgemeine Information Nummer ${i} ohne besondere Priorität.`
        ),
        'Die Entscheidung lautet: Laravel ist das Backend.',
      ].join('\n\n')
    )
    const records = planAutomaticChatCapture(input)
    expect(records).toHaveLength(8)
    expect(records.at(-1)?.content).toBe('Die Entscheidung lautet: Laravel ist das Backend.')
    expect(planAutomaticChatCapture(capture('a'.repeat(2000)))).toEqual([])
  })

  it('preserves exact file spelling and does not split a long sentence at a filename extension', () => {
    const inputs = planAutomaticChatCapture(
      capture('Die Datei `src/Foo.ts` muss geprüft werden.\n\nDie Datei `src/foo.ts` muss geprüft werden.')
    )
    expect(inputs).toHaveLength(2)
    const text = `Die Datei src/Foo.ts enthält ${'ein langes Detail '.repeat(80)}und muss vollständig geprüft werden. Die Entscheidung ist noch offen.`
    const excerpts = planAutomaticChatCapture(capture(text))
    expect(excerpts.map(record => record.content)).toEqual(['Die Entscheidung ist noch offen.'])
  })

  it.each([
    'Danke!',
    'weiterarbeiten',
    '[Fehler] Die Anfrage wurde abgebrochen.',
    'Mein API key ist ghp_abcdefghijklmnopqrstuvwxyz123456',
  ])('does not retain filler, failure or secret text: %s', content => {
    expect(planAutomaticChatCapture(capture(content))).toEqual([])
  })

  it('does not persist explicitly ephemeral chat data or a disabled auto-memory preference', async () => {
    const input = capture('Die Entscheidung lautet: Laravel ist das Backend.')
    expect(planAutomaticChatCapture({ ...input, message: { ...input.message, ephemeral: true } })).toEqual([])
    mocks.prefs.mockResolvedValue({ autoRemember: false })
    expect(await captureAutomaticChatMemory(input)).toBe(0)
    expect(mocks.remember).not.toHaveBeenCalled()
  })

  it('checks run ownership before every write and never continues after cancellation', async () => {
    const assertCurrent = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error('stopped')
      })
    await expect(
      captureAutomaticChatMemory(
        capture('Die erste Regel bleibt unverändert.\n\nDie zweite Regel benötigt einen Test.'),
        { assertCurrent }
      )
    ).rejects.toThrow('stopped')
    expect(mocks.remember).toHaveBeenCalledTimes(1)
  })
})

describe('context-aware local memory queries', () => {
  it('resolves brief followups from real user history and the active goal', () => {
    const query = buildMemoryContextQuery({
      text: 'Bitte weiterarbeiten',
      objective: 'Laravel Queue Import reparieren',
      messages: [
        { role: 'user', content: 'Der Laravel Import schlägt mit einem Queue Timeout fehl.' },
        { role: 'assistant', content: 'Erfundene wiederholte Vorliebe Fußball.' },
        { role: 'tool', content: 'sensitive dump' },
      ],
    })
    expect(query).toContain('Queue Timeout')
    expect(query).toContain('Laravel Queue Import reparieren')
    expect(query).not.toContain('Fußball')
    expect(query).not.toContain('sensitive dump')
  })

  it('does not pull a previous unrelated topic into a substantial new task', () => {
    const query = buildMemoryContextQuery({
      text: 'Plane einen Urlaub nach Japan mit Bahnreisen und Hotels',
      messages: [{ role: 'user', content: 'Laravel Datenbank Migration reparieren' }],
    })
    expect(query).not.toContain('Laravel')
  })

  it('excludes ephemeral/secret sources and bounds query material', () => {
    const query = buildMemoryContextQuery({
      text: 'weiter',
      messages: [
        { role: 'user', content: 'Mein API key ist ghp_abcdefghijklmnopqrstuvwxyz123456' },
        { role: 'user', content: 'Dieser private Inhalt darf nicht bleiben.', ephemeral: true },
        { role: 'user', content: 'Laravel '.repeat(2000) },
      ],
    })
    expect(query).not.toContain('ghp_')
    expect(query).not.toContain('privat')
    expect(query.length).toBeLessThanOrEqual(3000)
  })
})

describe('unconfirmed conversation recollection', () => {
  it('retains candidate evidence and permits only local history from the same conversation', () => {
    const record: MemoryRecord = {
      id: 'candidate-1',
      principalId: 'account-1',
      scope: 'project',
      dataset: 'project-1',
      contentHash: 'test-hash',
      type: 'note',
      visibility: 'private',
      retention: 'durable',
      importance: 0.5,
      tags: [],
      createdAt: 100,
      updatedAt: 100,
      content: 'Die Queue wurde laut Modell repariert.',
      source: 'assistant',
      status: 'candidate',
      sensitivity: 'normal',
      writeIntent: 'automatic',
      confidence: 0.35,
      meta: {
        memory_metadata: captureMemoryMetadata({
          content: 'Die Queue wurde laut Modell repariert.',
          source: 'assistant',
          origin: { messageId: 'message-1', conversationId: 'chat-1', role: 'assistant' },
        }),
      },
    }
    const [fragment] = sessionCandidateFragments([record], 'chat-1')
    expect(fragment).toMatchObject({
      source: 'history',
      scope: 'session',
      trust: 'untrusted_data',
      egress: 'local_only',
    })
    expect(JSON.parse(fragment!.content)).toMatchObject({
      status: 'candidate',
      role: 'assistant',
      sources: [{ messageId: 'message-1', role: 'assistant' }],
    })
    expect(record.status).toBe('candidate')
    expect(sessionCandidateFragments([record], 'chat-2')).toEqual([])
    expect(sessionCandidateFragments([{ ...record, status: 'active' }], 'chat-1')).toEqual([])
  })
})
