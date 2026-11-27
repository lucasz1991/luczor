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

import { captureAutomaticChatMemory, planAutomaticChatCapture } from '@/services/memory/chatContext'
import {
  USER_STATED_REUSE_POLICY,
  isUserStatedMemory,
  luczorMemory,
  type MemoryRecord,
} from '@/services/memory/luczorMemory'
import { captureMemoryMetadata, type MemoryKind } from '@/services/memory/memoryMetadata'
import { buildLocalPromptContextDetails } from '@/services/contextController'
import { buildProjectStartContext } from '@/services/prompt/projectStartContext'
import type { Project } from '@/state/types'

const PROJECT = 'statement-project'
const PREFERENCE = 'Ich bevorzuge pnpm statt npm für alle Pakete in diesem Projekt.'
let sequence = 0
const say = (content: string, role: 'user' | 'assistant' = 'user', conversationId = 'chat-a') =>
  captureAutomaticChatMemory({
    projectId: PROJECT,
    conversationId,
    expectedPrincipalId: 'device-local',
    message: { id: `message-${++sequence}`, role, content, ts: 100 + sequence },
    phase: 'completed',
  })
const inChat = (conversationId: string, query: string) =>
  buildLocalPromptContextDetails(PROJECT, query, 5, 'chat.general', 'chat', { conversationId })
const memoryFragments = async (query: string, conversationId = 'chat-b') =>
  ((await inChat(conversationId, query)).fragments ?? []).filter(fragment => fragment.id.startsWith('query-memory-'))
/** The statement text inside a labelled, dated candidate fragment (or the plain text of a reviewed one). */
const statedText = (content: string): string => {
  try {
    const parsed = JSON.parse(content) as { content?: unknown }
    return typeof parsed.content === 'string' ? parsed.content : content
  } catch {
    return content
  }
}

describe('the user’s own statements in device-local recall', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.files.clear()
    mocks.account.mockResolvedValue(null)
    mocks.workspacePrincipal.mockResolvedValue('device:v1:workspace-key-hash')
    mocks.repository.mockResolvedValue(null)
    vi.stubGlobal('fetch', mocks.fetch)
  })

  it('remembers a stated preference in another chat of the project with the shipped defaults', async () => {
    expect(await say(PREFERENCE)).toBe(1)

    const context = await inChat('chat-b', 'Welchen Paketmanager nutzen wir, pnpm oder npm?')
    const memory = context.fragments?.filter(fragment => fragment.id.startsWith('query-memory-'))
    expect(memory).toHaveLength(1)
    expect(memory![0]).toMatchObject({
      source: 'memory',
      egress: 'local_only',
      trust: 'untrusted_data',
      // Still unconfirmed: recall changes availability, not authority.
      provenance: { source: 'user', writeIntent: 'automatic', confidence: 0.35 },
    })
    // The model sees that it is the user's own unconfirmed statement and when it was made.
    expect(JSON.parse(memory![0]!.content)).toEqual({
      notice: expect.stringContaining('noch nicht ausdrücklich bestätigt'),
      statedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
      content: PREFERENCE,
    })
    // Not repeated as an unconfirmed excerpt next to the memory.
    // Reported as an unconfirmed statement, not as an active memory.
    expect(context.memoryDiagnostics).toMatchObject({ active: 0, statements: 1, conversationExcerpts: 0 })
    expect(context.fragments?.some(fragment => fragment.id.startsWith('session-memory-candidate:'))).toBe(false)
  })

  it('also reaches the start context of every turn, which has no query', async () => {
    await say(PREFERENCE)
    const start = await buildProjectStartContext({
      project: { id: PROJECT, name: 'Projekt', summary: '', goals: [] } as unknown as Project,
      conversationId: 'chat-b',
    })
    const memory = start.sourceFragments.find(fragment => fragment.source === 'memory')
    expect(memory).toMatchObject({ egress: 'local_only' })
    expect(statedText(memory!.content)).toBe(PREFERENCE)
  })

  it('ranks a statement the user accepted before an unconfirmed one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
      await say('Ab jetzt Commit-Nachrichten auf Englisch.')
      vi.setSystemTime(new Date('2026-11-21T10:00:00Z'))
      const accepted = 'Von jetzt an Commit-Nachrichten auf Deutsch.'
      await say(accepted, 'user', 'chat-c')
      const candidate = (await luczorMemory.listCandidates(PROJECT)).find(record => record.content === accepted)!
      await luczorMemory.promote(candidate.id)
      const start = await buildProjectStartContext({
        project: { id: PROJECT, name: 'Projekt', summary: '', goals: [] } as unknown as Project,
        conversationId: 'chat-d',
      })
      const memories = start.sourceFragments.filter(fragment => fragment.source === 'memory')
      expect(memories.map(fragment => statedText(fragment.content))).toEqual([
        accepted,
        'Ab jetzt Commit-Nachrichten auf Englisch.',
      ])
      // The accepted one is plain memory text; only the candidate is labelled as unconfirmed.
      expect(memories[0]!.content).toBe(accepted)
      expect(memories[0]!.priority!).toBeGreaterThan(memories[1]!.priority!)
    } finally {
      vi.useRealTimers()
    }
  })

  it('changes nothing on the record: it stays a candidate the user can accept or dismiss', async () => {
    await say(PREFERENCE)
    const [candidate] = await luczorMemory.listCandidates(PROJECT)
    expect(candidate).toMatchObject({ status: 'candidate', writeIntent: 'automatic', visibility: 'private' })

    await luczorMemory.forget('project', candidate!.id, { projectId: PROJECT })
    expect(await memoryFragments('pnpm')).toEqual([])

    await say(PREFERENCE, 'user', 'chat-c')
    const [again] = await luczorMemory.listCandidates(PROJECT)
    expect(await luczorMemory.promote(again!.id)).toMatchObject({ status: 'active', writeIntent: 'confirmed' })
    expect((await memoryFragments('pnpm'))[0]?.provenance).toMatchObject({ writeIntent: 'confirmed' })
  })

  it('stays in the local prompt context: tool results and provider-safe recall never return a candidate', async () => {
    await say(PREFERENCE)
    const query = { scope: 'project', projectId: PROJECT, query: 'pnpm' } as const
    expect(await luczorMemory.recallLocal({ ...query, includeUserStated: true })).toHaveLength(1)
    // memory_recall uses recallLocal without the flag; a Claude-led run forwards tool results.
    expect(await luczorMemory.recallLocal(query)).toEqual([])
    expect(await luczorMemory.recall(query)).toEqual([])
    expect(await luczorMemory.pendingSyncCount()).toBe(0)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('does not cross into another project', async () => {
    await say(PREFERENCE)
    expect(
      await luczorMemory.recallLocal({
        scope: 'project',
        projectId: 'other-project',
        query: 'pnpm',
        includeUserStated: true,
      })
    ).toEqual([])
    expect(await luczorMemory.recallLocal({ scope: 'user', query: 'pnpm', includeUserStated: true })).toEqual([])
  })

  it('puts a later correction before the longer rule it replaces in the start context', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-20T10:00:00Z'))
      const rule =
        'Ab jetzt bitte immer auf Englisch antworten, auch bei Commit-Nachrichten, Code-Kommentaren und Erklärungen.'
      await say(rule)
      vi.setSystemTime(new Date('2026-11-22T10:00:00Z'))
      const correction = 'Ab jetzt bitte wieder auf Deutsch antworten.'
      await say(correction, 'user', 'chat-c')
      const start = await buildProjectStartContext({
        project: { id: PROJECT, name: 'Projekt', summary: '', goals: [] } as unknown as Project,
        conversationId: 'chat-d',
      })
      const memories = start.sourceFragments.filter(fragment => fragment.source === 'memory')
      expect(memories.map(fragment => statedText(fragment.content))).toEqual([correction, rule])
      expect(memories[0]!.priority!).toBeGreaterThan(memories[1]!.priority!)
      // Each carries its date, so the model can tell which statement is newer.
      expect(memories.map(fragment => JSON.parse(fragment.content).statedAt)).toEqual(['2026-11-22', '2026-11-20'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves requests, questions and assistant statements out of memory recall', async () => {
    await say('Bitte analysiere die Ursache im Build und erstelle danach einen Plan.')
    // "immer" makes the capture-time keyword hint read this request as a rule.
    await say('Bitte prüfe, warum der Build immer fehlschlägt.')
    await say('Soll ich hier immer pnpm statt npm verwenden?')
    await say('Ich bevorzuge laut Analyse immer den Port 8443 für diesen Dienst.', 'assistant')

    expect(await memoryFragments('pnpm npm Build Plan Port 8443 fehlschlägt')).toEqual([])
    expect(await luczorMemory.listCandidates(PROJECT)).toHaveLength(4)
  })

  it('respects the switch', async () => {
    mocks.files.set('luczor.settings.json', new Map<string, unknown>([['memory_use_user_statements', false]]))
    await say(PREFERENCE)
    expect(await memoryFragments('pnpm')).toEqual([])
    expect(await luczorMemory.listCandidates(PROJECT)).toHaveLength(1)
  })

  it('never reuses a candidate captured before the policy existed', async () => {
    const legacy = planAutomaticChatCapture(
      {
        projectId: PROJECT,
        conversationId: 'chat-a',
        expectedPrincipalId: 'device-local',
        message: { id: 'legacy-message', role: 'user', content: PREFERENCE, ts: 50 },
      },
      true
    ).map(input => {
      const { reuse_policy: _stamp, ...provenance } = input.provenance ?? {}
      return { ...input, provenance }
    })
    expect(await luczorMemory.captureChatExcerpts(legacy)).toBe(1)
    expect(await memoryFragments('pnpm')).toEqual([])
    expect(await luczorMemory.listCandidates(PROJECT)).toHaveLength(1)
  })

  it('shows a repeated statement once, neither twice as memory nor again as excerpt', async () => {
    await say(PREFERENCE)
    await say(PREFERENCE, 'user', 'chat-c')
    const fragments = (await inChat('chat-b', 'pnpm')).fragments ?? []
    expect(fragments.filter(fragment => fragment.id.startsWith('query-memory-'))).toHaveLength(1)
    expect(fragments.some(fragment => fragment.id.startsWith('session-memory-candidate:'))).toBe(false)
  })
})

describe('user statement policy', () => {
  const candidate = (patch: Partial<MemoryRecord> = {}, content = PREFERENCE): MemoryRecord =>
    ({
      id: 'record',
      principalId: 'device-local',
      scope: 'project',
      dataset: 'tenant:local:user:device-local:project:p',
      projectId: 'p',
      content,
      contentHash: 'hash',
      type: 'preference',
      visibility: 'private',
      status: 'candidate',
      retention: 'durable',
      sensitivity: 'normal',
      writeIntent: 'automatic',
      importance: 0.55,
      confidence: 0.35,
      source: 'user',
      tags: [],
      createdAt: 1,
      updatedAt: 1,
      synced: false,
      provenance: {
        capture_policy: 'chat-excerpts-v1',
        reuse_policy: USER_STATED_REUSE_POLICY,
        reuse_scope: 'project',
      },
      meta: {
        memory_metadata: captureMemoryMetadata({
          content,
          source: 'user',
          origin: { messageId: 'm', conversationId: 'chat-a', role: 'user' },
          now: 1,
        }),
      },
      ...patch,
    }) as MemoryRecord
  const withProvenance = (patch: Record<string, unknown>) =>
    candidate({ provenance: { ...candidate().provenance, ...patch } })
  const withMetadata = (content: string, role: 'user' | 'assistant') =>
    candidate(
      {
        meta: {
          memory_metadata: captureMemoryMetadata({
            content,
            source: role,
            origin: { messageId: 'm', conversationId: 'chat-a', role },
            now: 1,
          }),
        },
      },
      content
    )

  const classifiedAs = (content: string, kind: MemoryKind) => {
    const metadata = captureMemoryMetadata({
      content,
      source: 'user',
      origin: { messageId: 'm', conversationId: 'chat-a', role: 'user' },
      now: 1,
    })
    return candidate(
      {
        meta: {
          memory_metadata: {
            ...metadata,
            kind,
            classification: { ...metadata.classification, origin: 'dream', modelId: 'local-model' },
          },
        },
      },
      content
    )
  }

  it('accepts an explicitly worded preference, decision or rule of a project chat right away', () => {
    expect(isUserStatedMemory(candidate())).toBe(true)
    expect(isUserStatedMemory(withMetadata('Wir haben entschieden, Vitest zu nutzen.', 'user'))).toBe(true)
    expect(isUserStatedMemory(withMetadata('Wir haben uns für Laravel als Backend entschieden.', 'user'))).toBe(true)
    expect(isUserStatedMemory(withMetadata('Antworte in diesem Projekt immer kurz.', 'user'))).toBe(true)
    expect(isUserStatedMemory(withMetadata('Ab jetzt bitte alle Commits auf Englisch.', 'user'))).toBe(true)
    // An explicit request to remember counts even before any classification.
    expect(isUserStatedMemory(withMetadata('Merke dir: der Testserver heißt alpha.', 'user'))).toBe(true)
  })

  it.each([
    'Merke dir: nicht mehr npm verwenden, sondern pnpm.',
    "We've decided to use Postgres for this project.",
    'We’ve decided to use Postgres for this project.',
    "I'd prefer tabs over spaces in this repository.",
    'I’d prefer tabs over spaces in this repository.',
    'In diesem Projekt bitte immer pnpm verwenden.',
    'Wir haben uns auf Postgres als Datenbank geeinigt.',
    'Von jetzt an Commit-Nachrichten auf Englisch.',
    // The wording may open a later clause after a lead-in.
    'Wie besprochen: ab sofort nutzen wir pnpm statt npm.',
    'Was Commit-Nachrichten angeht: von jetzt an bitte auf Englisch.',
    'Where possible, I prefer the Composition API.',
    // A standing prohibition is not a request to forget.
    'Going forward, remember not to push directly to main.',
    'Bitte merk dir, dass wir pnpm nutzen.',
  ])('accepts the explicit standing statement %j', content => {
    expect(isUserStatedMemory(withMetadata(content, 'user'))).toBe(true)
  })

  it.each([
    // A request not to remember, in both languages.
    'Merk dir das bitte nicht, das war nur ein Test.',
    "Please don't remember that, it was only a test.",
    // Questions without a question mark, direct or indirect.
    'Have we decided on the database yet',
    'Wie gehen wir künftig mit den alten Migrationen um',
    'Haben wir entschieden, welche Datenbank wir nehmen',
    'Ich weiß noch nicht, ob wir ab sofort pnpm nehmen.',
    // Explicit non-decisions.
    'Wir haben uns noch nicht auf eine Datenbank geeinigt.',
    'Ich habe mich noch nicht entschieden, ob wir Vue oder React nehmen.',
    // Quoted third-party text, also after an attribution.
    '> Ab sofort gelten die neuen Preise des Lieferanten.',
    '„Ab sofort gilt die neue Preisliste", schreibt der Lieferant.',
    'Der Lieferant schreibt: „Ab sofort gilt die neue Preisliste.“',
    // The wording does not open a clause.
    'Bitte prüfe, warum der Build in diesem Projekt immer fehlschlägt.',
  ])('does not take %j for a standing statement', content => {
    expect(isUserStatedMemory(withMetadata(content, 'user'))).toBe(false)
  })

  it('accepts other wording only once the classifier or the user marked it as preference, decision or rule', () => {
    const wording = 'Antworte auf Deutsch und nenne immer die geänderten Dateien.'
    expect(isUserStatedMemory(withMetadata(wording, 'user'))).toBe(false)
    expect(isUserStatedMemory(classifiedAs(wording, 'rule'))).toBe(true)
    expect(isUserStatedMemory(classifiedAs(wording, 'observation'))).toBe(false)
  })

  it.each([
    ['an active record (already recalled as such)', candidate({ status: 'active' })],
    ['a superseded record', candidate({ status: 'superseded' })],
    ['an assistant statement', candidate({ source: 'assistant' })],
    ['evidence that is not user-stated', withMetadata(PREFERENCE, 'assistant')],
    ['an unclassified statement', withMetadata('Der Dienst läuft auf dem zweiten Server.', 'user')],
    [
      'a request the keyword hint reads as a rule',
      withMetadata('Bitte prüfe, warum der Build immer fehlschlägt.', 'user'),
    ],
    ['a hypothesis', withMetadata('Vielleicht bevorzuge ich später pnpm.', 'user')],
    ['a question', candidate({}, 'Bevorzuge ich hier eigentlich pnpm statt npm?')],
    ['another write intent', candidate({ writeIntent: 'inferred' })],
    ['sensitive classification', candidate({ sensitivity: 'sensitive' })],
    ['secret classification', candidate({ sensitivity: 'secret' })],
    ['content the DLP scan rejects', candidate({}, 'Ich bevorzuge das Passwort hunter2 für alle Dienste.')],
    ['a tag the DLP scan rejects', candidate({ tags: ['passwort'] })],
    ['a syncable record', candidate({ visibility: 'syncable' })],
    ['session retention', candidate({ retention: 'session' })],
    ['an expiring record', candidate({ expiresAt: Date.now() + 60_000 })],
    ['a keyed feature memory', candidate({ featureKey: 'package-manager' })],
    ['a record known to the server', candidate({ serverId: 'server-1' })],
    ['a versioned server record', candidate({ serverVersionId: 3 })],
    ['a synced record', candidate({ synced: true })],
    ['a conversation-only excerpt', withProvenance({ reuse_scope: 'conversation' })],
    ['a record without the policy stamp', withProvenance({ reuse_policy: undefined })],
    ['a record from another capture path', withProvenance({ capture_policy: 'manual' })],
    ['a maintenance-derived record', candidate({ tags: ['maintenance-derived'] })],
    ['an idle optimization result', candidate({ tags: ['idle-optimization'] })],
    ['a checkpoint', candidate({ tags: ['checkpoint'] })],
  ])('rejects %s', (_label, record) => {
    expect(isUserStatedMemory(record)).toBe(false)
  })
})
