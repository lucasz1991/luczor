import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { RunAgentOptions } from '@/services/agent'
import type { SavedResearch } from '@/services/research/store'
import type { ResearchToolsOptions } from '@/services/research/tools'
import type { ExecutionTicket } from '@/services/executionGate'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import type { WireMessage } from '@/services/inference/types'

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
vi.mock('@/services/research/store', async importOriginal => ({
  ...(await importOriginal<typeof import('@/services/research/store')>()),
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
function evidenceMessage(output: unknown): WireMessage {
  return {
    role: 'tool',
    name: 'research_read_evidence',
    tool_call_id: crypto.randomUUID(),
    content: JSON.stringify({ ok: true, output }),
  }
}
function presentEvidence(options: RunAgentOptions, messages: readonly WireMessage[]) {
  options.onContextRequest?.({ target: 'local_llama_cpp', messages })
}
function arrangeModel(readReview = true, freshness = 'current', segmentCount = 1) {
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
        segments: Array.from({ length: segmentCount }, (_, index) => ({
          id: `p${index + 1}`,
          text: `Der dokumentierte aktuelle Stand, Abschnitt ${index + 1}.`,
          locator: `Status ${index + 1}`,
        })),
      })
      await invokeProposal(options, 'research_submit_claims', {
        claims: [
          {
            id: 'c1',
            text: 'Dokumentierter Stand.',
            questionIds: ['q1'],
            evidence: Array.from({ length: segmentCount }, (_, index) => ({
              sourceId: 's1',
              segmentId: `p${index + 1}`,
            })),
          },
        ],
        limitations: [],
      })
    } else {
      if (readReview) {
        const output = await invokeProposal(options, 'research_read_evidence', { source_id: 's1', segment_id: 'p1' })
        presentEvidence(options, [evidenceMessage(output)])
      }
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
  it('rejects same-batch review submission until a later inference request receives the complete evidence', async () => {
    arrangeModel()
    const ordinaryModel = mock.model.getMockImplementation()!
    mock.model.mockImplementation(async (options: RunAgentOptions) => {
      if (!options.additionalTools?.some(tool => tool.name === 'research_submit_review')) return ordinaryModel(options)
      const output = await invokeProposal(options, 'research_read_evidence', { source_id: 's1', segment_id: 'p1' })
      const proposal = {
        claims: [
          { claimId: 'c1', supported: true, freshness: 'current', explanation: 'Die Fundstelle trägt die Aussage.' },
        ],
        issues: [],
        summary: 'Beleg geprüft.',
      }
      await expect(invokeProposal(options, 'research_submit_review', proposal)).rejects.toThrow('Modellkontext')
      expect(mock.saved.get(options.runId!)?.run.reviewProgress?.deliveredReceiptIds).toEqual([])
      presentEvidence(options, [evidenceMessage({ ...(output as object), text: 'gekürzt' })])
      await expect(invokeProposal(options, 'research_submit_review', proposal)).rejects.toThrow('Modellkontext')
      presentEvidence(options, [evidenceMessage(output)])
      await invokeProposal(options, 'research_submit_review', proposal)
      return result
    })
    await startResearch(input)
    await Promise.all(mock.jobs)
    expect(researchRuns.value[0]?.status).toBe('completed')
    expect(researchRuns.value[0]?.review?.readReceiptIds).toEqual(['review:s1:p1'])
  })
  it('continues a sequential thirteen-segment review across bounded model sections and a durable restart', async () => {
    arrangeModel(true, 'current', 13)
    const ordinaryModel = mock.model.getMockImplementation()!
    let readCount = 0
    let interruptNextSection = false
    const continuations: (AgentCheckpoint | undefined)[] = []
    const evidenceMessages: WireMessage[] = []
    mock.model.mockImplementation(async (options: RunAgentOptions) => {
      if (!options.additionalTools?.some(tool => tool.name === 'research_submit_review')) return ordinaryModel(options)
      continuations.push(options.continuation)
      if (interruptNextSection) {
        interruptNextSection = false
        throw new Error('provider-disconnected')
      }
      const end = Math.min(readCount + 6, 13)
      while (readCount < end) {
        presentEvidence(options, evidenceMessages)
        readCount++
        const output = await invokeProposal(options, 'research_read_evidence', {
          source_id: 's1',
          segment_id: `p${readCount}`,
        })
        evidenceMessages.push(evidenceMessage(output))
        expect(mock.saved.get(options.runId!)?.run.reviewProgress?.readReceiptIds).toHaveLength(readCount)
      }
      if (readCount < 13) {
        const continuation: AgentCheckpoint = {
          projectId: input.projectId,
          principalScopeId: 'account-a',
          conversationId: input.conversationId,
          sessionId: options.execution!.sessionId,
          generation: options.execution!.generation,
          objective: input.topic,
          messages: [{ role: 'assistant', content: `Prüfung bis Abschnitt ${readCount}` }, ...evidenceMessages],
          completedMutations: [],
          dataPolicy: 'local_only',
          ephemeralDataUsed: false,
        }
        if (readCount === 6) interruptNextSection = true
        return {
          ...result,
          finalText: 'Dieser Arbeitsabschnitt wird fortgesetzt.',
          interrupted: { code: 'round_limit', message: 'Abschnittsgrenze erreicht.' },
          continuation,
        }
      }
      presentEvidence(options, evidenceMessages)
      await invokeProposal(options, 'research_submit_review', {
        claims: [
          {
            claimId: 'c1',
            supported: true,
            freshness: 'current',
            explanation: 'Alle 13 Fundstellen tragen die Aussage.',
          },
        ],
        issues: [],
        summary: 'Alle Belege getrennt gelesen.',
      })
      return result
    })
    const id = await startResearch(input)
    await Promise.all(mock.jobs)
    expect(researchRuns.value[0]?.status).toBe('blocked')
    expect(researchRuns.value[0]?.blockers).toContain('provider-disconnected')
    expect(mock.saved.get(id)?.run.reviewProgress?.readReceiptIds).toHaveLength(6)
    expect(mock.saved.get(id)?.run.reviewProgress?.deliveredReceiptIds).toHaveLength(5)
    const firstCheckpoint = mock.saved.get(id)?.checkpoint
    expect(firstCheckpoint?.messages[0]?.content).toContain('Abschnitt 6')
    clearResearch()
    await recoverResearch('account-a')
    await resumeResearch(id, 'act', 'balanced')
    await Promise.all(mock.jobs)
    const completed = researchRuns.value[0]!
    expect(completed.status).toBe('completed')
    expect(completed.review?.readReceiptIds).toHaveLength(13)
    expect(completed.reviewProgress).toBeUndefined()
    expect(continuations[0]).toBeUndefined()
    expect(continuations[1]?.messages).toEqual(firstCheckpoint?.messages)
    expect(continuations[2]?.messages).toEqual(firstCheckpoint?.messages)
    expect(continuations[3]?.messages[0]?.content).toContain('Abschnitt 12')
    expect(mock.files.get('bericht.md')?.content).toContain('Geprüfter Recherchebericht')
  })
  it('waits for an essential clarification and replans in the same approved output directory', async () => {
    arrangeModel()
    const ordinaryModel = mock.model.getMockImplementation()!
    let needsClarification = true
    const followUpPlans: string[] = []
    mock.model.mockImplementation(async (options: RunAgentOptions) => {
      if (needsClarification) {
        needsClarification = false
        await invokeProposal(options, 'research_request_clarification', {
          question: 'Für welchen Markt gilt die Recherche?',
        })
        return result
      }
      if (options.additionalTools?.some(tool => tool.name === 'research_submit_plan'))
        followUpPlans.push(JSON.stringify(options.baseMessages))
      return ordinaryModel(options)
    })
    const id = await startResearch(input)
    await Promise.all(mock.jobs)
    const initial = researchRuns.value[0]!
    expect(initial.status).toBe('blocked')
    expect(initial.stage).toBe('planning')
    expect(initial.blockers).toEqual(['Für welchen Markt gilt die Recherche?'])
    expect(mock.files.get('bericht.md')?.content).toContain('Zwischenbericht')
    await resumeResearch(id, 'act', 'balanced', 'Deutschland, Stand heute.')
    await Promise.all(mock.jobs)
    const completed = researchRuns.value[0]!
    expect(completed.status).toBe('completed')
    expect(completed.id).toBe(id)
    expect(completed.outputDir).toBe(initial.outputDir)
    expect(completed.clarifications).toEqual(['Deutschland, Stand heute.'])
    expect(followUpPlans).toHaveLength(1)
    expect(followUpPlans[0]).toContain('Deutschland, Stand heute.')
    expect(mock.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: id, expectedRootPath: initial.outputDir, resume: true }),
      expect.anything()
    )
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
    const ready = new Promise<void>(resolve => {
      entered = resolve
    })
    const pending = new Promise<void>(resolve => {
      finish = resolve
    })
    mock.model.mockImplementation(async () => {
      entered()
      await pending
      return result
    })
    const id = await startResearch(input)
    await ready
    const initialReport = mock.files.get('bericht.md')?.content
    mock.handles[0]!.abort()
    expect(mock.tickets.get(id)?.signal.aborted).toBe(true)
    finish()
    await Promise.all(mock.jobs)
    expect(researchRuns.value[0]?.status).toBe('paused')
    expect(mock.files.size).toBe(4)
    expect(mock.files.get('bericht.md')?.content).toBe(initialReport)
    expect(initialReport).toContain('Zwischenbericht')
    expect(mock.release).toHaveBeenCalledWith(id, expect.anything())
  })
})
