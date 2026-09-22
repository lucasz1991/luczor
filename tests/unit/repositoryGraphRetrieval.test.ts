import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), policy: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({ get: mocks.policy }) } }))
vi.mock('@/services/memory/usage', () => ({ trackMemoryUsage: (_: string, run: () => unknown) => run() }))
import { buildLocalRepositoryContext, type GraphSearchHit } from '@/services/repositoryGraph'
import { buildScopedContextPackage } from '@/services/inference/contextBroker'

const hit = (id: string, path = `src/${id}.ts`, fields: Partial<GraphSearchHit> = {}): GraphSearchHit => ({
  evidence_id: id,
  relative_path: path,
  language: 'typescript',
  symbols: [],
  reasons: ['full_text'],
  score: 0.2,
  content_hash: `hash-${id}`,
  stale: false,
  relations: ['imports: shared.ts'],
  ...fields,
})

describe('automatic repository retrieval', () => {
  beforeEach(() => {
    mocks.policy.mockReset().mockResolvedValue('deny')
    mocks.invoke.mockReset().mockImplementation(async (command, args) => {
      if (command === 'local_graph_status') return { status: 'ready' }
      if (command === 'local_graph_search')
        return { repository_id: 'repo-a', commit_sha: 'commit-a', hits: [hit('agent', 'src/services/agent.ts')] }
      if (command === 'local_graph_read_snippets')
        return {
          snippets: args.evidenceIds.map((id: string) => ({
            evidence_id: id,
            relative_path: 'src/services/agent.ts',
            start_line: 900,
            end_line: 910,
            content: 'function resumeAgent() {}',
            content_hash: `hash-${id}`,
            redactions: 0,
          })),
          omitted: [],
        }
    })
  })

  it('automatically retrieves task context on general continuation and preserves actual source lines/hash', async () => {
    const result = await buildLocalRepositoryContext(
      'account-a',
      'project-a',
      'weiterarbeiten',
      'chat.general',
      6,
      false,
      'local',
      'chat',
      'resumeAgent in src/services/agent.ts'
    )
    expect(result.text).toContain('src/services/agent.ts:900-910')
    expect(result.text).toContain('Hash: hash-agent')
    expect(result.diagnostics).toMatchObject({
      status: 'ready',
      contextual: true,
      selectedFiles: 1,
      materializedFiles: 1,
      relationCount: 1,
    })
    const read = mocks.invoke.mock.calls.find(([command]) => command === 'local_graph_read_snippets')!
    expect(read[1]).toMatchObject({
      principalId: 'account-a',
      projectId: 'project-a',
      query: expect.stringContaining('resumeAgent'),
    })
  })

  it('ranks an exact file above broad FTS matches and keeps all searches local', async () => {
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === 'local_graph_status') return { status: 'ready' }
      if (command === 'local_graph_search')
        return { repository_id: 'repo-a', hits: [hit('other'), hit('agent', 'src/services/agent.ts')] }
      if (command === 'local_graph_read_snippets')
        return {
          snippets: [],
          omitted: args.evidenceIds.map((id: string) => ({ evidence_id: id, reason: 'stale_hash' })),
        }
    })
    const result = await buildLocalRepositoryContext(
      'a',
      'p',
      'Bitte src/services/agent.ts prüfen',
      'chat.general',
      1,
      false,
      'local'
    )
    expect(mocks.invoke).toHaveBeenCalledWith(
      'local_graph_read_snippets',
      expect.objectContaining({ evidenceIds: ['agent'] })
    )
    expect(result.hints).toEqual([])
    expect(result.text).toBe('')
    expect(result.diagnostics?.omissionReasons).toContain('stale_hash')
  })

  it('retains external deny/ask and never materializes code before approval', async () => {
    for (const policy of ['deny', 'ask']) {
      mocks.policy.mockResolvedValue(policy)
      const result = await buildLocalRepositoryContext('a', 'p', 'resumeAgent', 'chat.general')
      expect(result.text).toBe('')
      expect(result.hints).toEqual([])
      expect(result.requiresApproval).toBe(policy === 'ask')
      expect(result.diagnostics?.status).toBe('blocked')
    }
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'local_graph_read_snippets')).toBe(false)
  })

  it('rejects mismatched repository revisions across query expansion', async () => {
    let search = 0
    mocks.invoke.mockImplementation(async command =>
      command === 'local_graph_status'
        ? { status: 'ready' }
        : {
            repository_id: 'repo-a',
            commit_sha: `commit-${search++}`,
            hits: [hit('agent')],
          }
    )
    const result = await buildLocalRepositoryContext(
      'a',
      'p',
      'resumeAgent src/agent.ts',
      'coding.fix_bug',
      6,
      false,
      'local'
    )
    expect(result.text).toBe('')
    expect(result.diagnostics?.omissionReasons).toEqual(['repository_changed'])
  })

  it('does not report a stale or mismatched snippet as supplied evidence', async () => {
    mocks.invoke.mockImplementation(async command => {
      if (command === 'local_graph_status') return { status: 'ready' }
      if (command === 'local_graph_search') return { repository_id: 'repo-a', hits: [hit('agent')] }
      return {
        snippets: [
          { evidence_id: 'agent', relative_path: 'src/agent.ts', content_hash: 'changed', content: 'wrong revision' },
        ],
        omitted: [],
      }
    })
    const result = await buildLocalRepositoryContext('a', 'p', 'src/agent.ts', 'coding.fix_bug', 6, false, 'local')
    expect(result.fragments).toEqual([])
    expect(result.hints).toEqual([])
    expect(result.diagnostics?.omissionReasons).toEqual(['evidence_changed'])
  })

  it('reports graph readiness instead of silently pretending no source matches', async () => {
    mocks.invoke.mockResolvedValue({ status: 'stale' })
    const result = await buildLocalRepositoryContext('a', 'p', 'Fix agent', 'coding.fix_bug', 6, false, 'local')
    expect(result.diagnostics).toMatchObject({ status: 'not_ready', graphStatus: 'stale', queryCount: 0 })
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it('delivers a long-file match through the real atomic broker with exact source lines and hash', async () => {
    const sourceLines = [
      ...Array.from({ length: 80 }, (_, index) => `// unrelated line ${index}: ${'\\"'.repeat(40)}`),
      'export function resumeAgent() {',
      "  return 'complete source evidence';",
      '}',
      ...Array.from({ length: 200 }, (_, index) => `// trailing source line ${index}`),
    ]
    mocks.invoke.mockImplementation(async command => {
      if (command === 'local_graph_status') return { status: 'ready' }
      if (command === 'local_graph_search') return { repository_id: 'repo-a', hits: [hit('agent', 'src/agent.ts')] }
      return {
        snippets: [
          {
            evidence_id: 'agent',
            relative_path: 'src/agent.ts',
            content_hash: 'hash-agent',
            content: sourceLines.join('\n'),
            start_line: 600,
            end_line: 600 + sourceLines.length - 1,
          },
        ],
        omitted: [],
      }
    })
    const result = await buildLocalRepositoryContext(
      'account-a',
      'project-a',
      'resumeAgent',
      'coding.fix_bug',
      6,
      false,
      'local'
    )
    const fragment = result.fragments![0]!
    expect(fragment.content).toContain('function resumeAgent()')
    expect(fragment.content).toContain('Hash: hash-agent')
    expect(JSON.stringify(fragment.content).length).toBeLessThanOrEqual(3400)
    const range = fragment.content.match(/src\/agent\.ts:(\d+)-(\d+)/u)!
    const first = Number(range[1])
    const last = Number(range[2])
    expect(first).toBeGreaterThanOrEqual(676)
    expect(first).toBeLessThanOrEqual(680)
    expect(last).toBeGreaterThanOrEqual(682)
    expect(fragment.content.split('\n')[2]).toBe(sourceLines[first - 600])
    expect(result.diagnostics?.omissionReasons).toContain('focused_source_window')
    const scope = {
      principalId: 'account-a',
      serverInstance: 'server-a',
      projectId: 'project-a',
      sessionId: 'chat-a',
      taskType: 'coding.fix_bug',
    }
    const packet = await buildScopedContextPackage({
      scopeKey: scope,
      target: 'local_llama_cpp',
      budget: { maxChars: 16_000, maxFragments: 24, maxFragmentChars: 4_000 },
      fragments: [
        {
          ...fragment,
          source: 'repository',
          trust: 'untrusted_data',
          scope,
          lifecycle: 'active',
          sensitivity: 'normal',
          audiences: ['local_model'],
          egress: 'local_only',
          contentHash: '',
        },
      ],
    })
    expect(packet.selected).toHaveLength(1)
    expect(packet.omitted).toEqual([])
    expect(packet.text).toContain('resumeAgent')
  })

  it('reports an oversized atomic source line rather than truncating it and claiming complete evidence', async () => {
    mocks.invoke.mockImplementation(async command => {
      if (command === 'local_graph_status') return { status: 'ready' }
      if (command === 'local_graph_search') return { repository_id: 'repo-a', hits: [hit('agent', 'src/agent.ts')] }
      return {
        snippets: [
          {
            evidence_id: 'agent',
            relative_path: 'src/agent.ts',
            content_hash: 'hash-agent',
            content: `function resumeAgent() { return '${'a'.repeat(6000)}' }`,
            start_line: 100,
            end_line: 100,
          },
        ],
        omitted: [],
      }
    })
    const result = await buildLocalRepositoryContext('a', 'p', 'resumeAgent', 'coding.fix_bug', 6, false, 'local')
    expect(result.fragments).toEqual([])
    expect(result.hints).toEqual([])
    expect(result.diagnostics?.materializedFiles).toBe(0)
    expect(result.diagnostics?.omissionReasons).toContain('source_line_exceeds_context_budget')
  })
})
