import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { RunAgentOptions } from '@/services/agent'
import type { SavedResearch } from '@/services/research/store'
import type { ResearchToolsOptions } from '@/services/research/tools'
import type { ExecutionTicket } from '@/services/executionGate'

const mock = vi.hoisted(() => ({
  model: vi.fn(),
  approve: vi.fn(),
  prepare: vi.fn(),
  release: vi.fn(),
  verify: vi.fn(),
  files: new Map<string, { content: string; sha256: string }>(),
  saved: new Map<string, SavedResearch>(),
  tickets: new Map<string, AbortController>(),
  jobs: [] as Promise<unknown>[],
  handles: [] as AbortController[],
  tools: undefined as ResearchToolsOptions | undefined,
  writeFailure: false,
  principal: 'account-a',
}))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('@/services/agent', () => ({ runAgent: mock.model, buildSystemPreamble: () => 'system' }))
vi.mock('@/services/confirmation', () => ({ requestConfirmation: mock.approve }))
vi.mock('@/services/projectWorkspace', () => ({
  resolveWorkspacePrincipalId: async () => mock.principal,
  getProjectWorkspace: async () => null,
}))
vi.mock('@/services/research/settings', () => ({ getResearchRoot: async () => undefined }))
vi.mock('@/services/tools/registry', () => ({ listTools: () => [] }))
vi.mock('@/services/chatEffectJournal', () => ({ createChatEffectJournal: () => ({}) }))
vi.mock('@/services/runs/runCoordinator', () => ({
  runCoordinator: { prepareResume: async () => ({ status: 'ready' }) },
}))
vi.mock('@/services/executionGate', () => ({
  executionGate: {
    capture: (_: unknown, scope: { runId: string }, mode: string) => {
      const controller = new AbortController()
      mock.tickets.set(scope.runId, controller)
      return { sessionId: 'session', generation: 1, scopeGeneration: 1, scope, mode, signal: controller.signal }
    },
    assert: (ticket: ExecutionTicket) => ticket.signal.throwIfAborted(),
  },
  invalidateExecutionScope: (scope: { runId: string }) => mock.tickets.get(scope.runId)?.abort(),
}))
vi.mock('@/services/chatRunManager', () => ({
  chatRuns: {
    submit: (_scope: unknown, action: (handle: unknown) => Promise<void>) => {
      const controller = new AbortController()
      mock.handles.push(controller)
      const job = action({
        signal: controller.signal,
        setMessage: async () => {},
        setWaiting: async () => {},
        interrupt: async () => {},
      })
      mock.jobs.push(job)
      return job
    },
  },
}))
vi.mock('@/services/research/store', () => ({
  createResearchStore: () => ({
    save: async (saved: SavedResearch) => {
      mock.saved.set(saved.run.id, structuredClone(saved))
    },
    list: async (principal: string) =>
      [...mock.saved.values()].filter(item => item.run.principalId === principal).map(item => structuredClone(item)),
  }),
}))
vi.mock('@/services/research/native', () => ({
  researchPreview: async () => ({ rootPath: 'C:\\Research\\owned-run' }),
  researchPrepare: mock.prepare,
  researchRelease: mock.release,
  researchOpen: vi.fn(),
  researchVerify: mock.verify,
  researchWrite: async (_id: string, path: string, content: string, ticket: ExecutionTicket, expected?: string) => {
    ticket.signal.throwIfAborted()
    if (mock.writeFailure) throw new Error('disk-full')
    if (mock.files.get(path)?.sha256 !== expected) throw new Error('write-conflict')
    const sha256 = createHash('sha256').update(content).digest('hex')
    mock.files.set(path, { content, sha256 })
    return { path, sha256, bytes: content.length }
  },
  researchRead: async (_id: string, path: string) => ({ path, ...mock.files.get(path), bytes: 1 }),
}))
vi.mock('@/services/research/tools', () => ({
  createResearchTools: (options: ResearchToolsOptions) => {
    mock.tools = options
    return []
  },
}))

import {
  startResearch,
  resumeResearch,
  clearResearch,
  recoverResearch,
  researchRuns,
} from '@/services/research/service'

const input = {
  projectId: 'chat-space',
  conversationId: 'conversation',
  topic: 'Aktuellen Stand prüfen',
  mode: 'act' as const,
  thinkingTier: 'balanced' as const,
  standalone: true,
}
const result = { finalText: '', toolFailures: 0, toolSuccesses: 1, ephemeralDataUsed: false }
async function invokeProposal(options: RunAgentOptions, name: string, args: Record<string, unknown>) {
  const tool = options.additionalTools?.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`Missing tool ${name}`)
  return tool.execute(args, { projectId: input.projectId, execution: options.execution })
}
function arrangeModel(readReview = true, freshness = 'current') {
  mock.model.mockImplementation(async (options: RunAgentOptions) => {
    if (options.additionalTools?.some(tool => tool.name === 'research_submit_plan')) {
      await invokeProposal(options, 'research_submit_plan', {
        questions: [{ id: 'q1', text: 'Aktueller Stand?', requiresFreshness: true }],
        queries: ['official current'],
      })
    } else if (options.additionalTools?.some(tool => tool.name === 'research_submit_claims')) {
      await mock.tools!.captureSource({
        id: 's1',
        url: 'https://example.org/current',
        title: 'Offizielle Quelle',
        capturedAt: Date.now(),
        contentHash: 'a'.repeat(64),
        readReceiptId: 'native-read',
        kind: 'web',
        coverage: 'complete',
        segments: [{ id: 'p1', text: 'Der dokumentierte aktuelle Stand.', locator: 'Status' }],
      })
      await invokeProposal(options, 'research_submit_claims', {
        claims: [
          {
            id: 'c1',
            text: 'Dokumentierter Stand.',
            questionIds: ['q1'],
            evidence: [{ sourceId: 's1', segmentId: 'p1' }],
          },
        ],
        limitations: [],
      })
    } else {
      if (readReview) await invokeProposal(options, 'research_read_evidence', { source_id: 's1', segment_id: 'p1' })
      await invokeProposal(options, 'research_submit_review', {
        claims: [
          { claimId: 'c1', supported: true, freshness, explanation: 'Die gelesene Fundstelle trägt diese Aussage.' },
        ],
        issues: [],
        summary: 'Beleg geprüft.',
      })
    }
    return result
  })
}
beforeEach(() => {
  clearResearch()
  mock.files.clear()
  mock.saved.clear()
  mock.jobs.length = 0
  mock.handles.length = 0
  mock.tickets.clear()
  mock.model.mockReset()
  mock.approve.mockReset()
  mock.prepare.mockReset()
  mock.release.mockReset()
  mock.verify.mockReset()
  mock.principal = 'account-a'
  mock.writeFailure = false
  mock.approve.mockResolvedValue({ approved: true })
  mock.release.mockResolvedValue(true)
  mock.prepare.mockImplementation(async input => ({
    ...input,
    chatId: input.chatId,
    rootPath: input.expectedRootPath,
    revision: 1,
    workflowScope: {
      principalId: input.principalId,
      projectId: input.projectId,
      runId: input.runId,
      researchId: input.runId,
    },
  }))
  mock.verify.mockImplementation(async (_id: string, files: { path: string; sha256: string }[]) => ({
    ok: files.every(file => mock.files.get(file.path)?.sha256 === file.sha256),
    files,
  }))
})

describe('production research phase integration', () => {
  it('completes only after separate evidence reads and verified MD/HTML persistence', async () => {
    arrangeModel()
    const id = await startResearch(input)
    await Promise.all(mock.jobs)
    expect(researchRuns.value.find(run => run.id === id)?.status).toBe('completed')
    expect(mock.model).toHaveBeenCalledTimes(3)
    expect(mock.files.get('bericht.md')?.content).toContain('Geprüfter Recherchebericht')
    expect(mock.files.get('bericht.html')?.content).toContain('Content-Security-Policy')
    expect(mock.files.has('belege/s1.json')).toBe(true)
    expect(mock.release).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ scope: expect.objectContaining({ runId: id }) })
    )
  })
  it('cannot complete a review that asserts support without reading the stored evidence', async () => {
    arrangeModel(false)
    await startResearch(input)
    await Promise.all(mock.jobs)
    expect(researchRuns.value[0]?.status).toBe('blocked')
    expect(mock.files.get('bericht.md')?.content).toContain('Zwischenbericht')
  })
  it('retains an intermediate report when an allegedly supported current claim has stale evidence', async () => {
    arrangeModel(true, 'stale')
    await startResearch(input)
    await Promise.all(mock.jobs)
    expect(researchRuns.value[0]?.status).toBe('blocked')
    expect(mock.files.get('bericht.md')?.content).toContain('Zwischenbericht')
  })
  it('blocks on disk failure and releases the exact grant', async () => {
    arrangeModel()
    mock.writeFailure = true
    const id = await startResearch(input)
    await Promise.all(mock.jobs)
    expect(researchRuns.value[0]?.status).toBe('blocked')
    expect(researchRuns.value[0]?.blockers).toContain('disk-full')
    expect(mock.release).toHaveBeenCalledWith(id, expect.anything())
  })
  it('refuses corrupt saved files after account-scoped restart before calling the model', async () => {
    arrangeModel(false)
    const id = await startResearch(input)
    await Promise.all(mock.jobs)
    clearResearch()
    await recoverResearch('account-a')
    mock.files.set('belege/s1.json', { content: 'tampered', sha256: 'bad' })
    mock.model.mockClear()
    await resumeResearch(id, 'act', 'balanced')
    await Promise.all(mock.jobs)
    expect(researchRuns.value[0]?.status).toBe('blocked')
    expect(mock.model).not.toHaveBeenCalled()
  })
  it('does not create a folder or run when the bounded initial grant is denied', async () => {
    mock.approve.mockResolvedValue({ approved: false })
    await expect(startResearch(input)).rejects.toThrow('nicht freigegeben')
    expect(mock.prepare).not.toHaveBeenCalled()
    expect(researchRuns.value).toEqual([])
  })
  it('revokes the native ticket when the composer stops its chat admission', async () => {
    let entered!: () => void
    let finish!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<void>(resolve => { finish = resolve })
    mock.model.mockImplementation(async () => {
      entered()
      await pending
      return result
    })
    const id = await startResearch(input)
    await ready
    mock.handles[0]!.abort()
    expect(mock.tickets.get(id)?.signal.aborted).toBe(true)
    finish()
    await Promise.all(mock.jobs)
    expect(researchRuns.value[0]?.status).toBe('paused')
    expect(mock.files.size).toBe(0)
    expect(mock.release).toHaveBeenCalledWith(id, expect.anything())
  })
})
