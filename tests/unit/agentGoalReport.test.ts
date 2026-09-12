import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  getTool: vi.fn(),
  descriptors: vi.fn(),
  resolveRoute: vi.fn(),
  team: vi.fn(),
  approve: vi.fn(),
  queue: vi.fn(),
  update: vi.fn(),
  hidden: vi.fn(),
  audit: vi.fn(),
  hud: { killSwitch: false },
}))
vi.mock('@/services/inference/coordinator', () => ({ resolveInferenceRouteForTurn: mocks.resolveRoute }))
vi.mock('@/services/tools/registry', () => ({ getTool: mocks.getTool, toOpenAITools: mocks.descriptors }))
vi.mock('@/services/agents/chatOrchestration', () => ({ runChatAgentTeam: mocks.team }))
vi.mock('@/services/approvals', () => ({ awaitApproval: mocks.approve }))
vi.mock('@/services/executionPolicy', () => ({
  loadExecutionPolicy: async () => ({}),
  canAutoExecuteTool: () => false,
}))
vi.mock('@/state/store', () => ({
  mutations: { queueToolCall: mocks.queue, updateToolCallStatus: mocks.update, addHiddenToolMessage: mocks.hidden },
}))
vi.mock('@/state/hud', () => ({ hud: mocks.hud, setStatus: vi.fn(), pulse: vi.fn(), setLastTool: vi.fn() }))
vi.mock('@/services/api/sync', () => ({ logAgentEvent: mocks.audit }))

import { runAgent, type RunAgentOptions } from '@/services/agent'
import type { InferenceRequest, InferenceResult } from '@/services/inference/types'
import { GOAL_REPORT_MARKER } from '@/services/agents/goalReport'

const gateway = { id: 'local-test', target: 'local_llama_cpp' as const, streamChatWithTools: mocks.stream }
const finalResponse = (): InferenceResult => ({
  content: 'Ergebnis geprüft.',
  toolCalls: [],
  rawToolCalls: [],
  finishReason: 'stop',
})
function toolResponse(args: Record<string, unknown>, name = 'goal_report', id = 'report-1'): InferenceResult {
  const rawArguments = JSON.stringify(args)
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [{ id, name, arguments: args, rawArguments }],
    rawToolCalls: [{ id, type: 'function', function: { name, arguments: rawArguments } }],
  }
}
const options = (extra: Partial<RunAgentOptions> = {}): RunAgentOptions => ({
  projectId: 'goal-project',
  baseMessages: [{ role: 'user', content: 'Bearbeite den Auftrag.' }],
  mode: 'observe',
  maxRounds: 3,
  inferenceGateway: gateway,
  ...extra,
})
function offered(request: InferenceRequest): string[] {
  return (request.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)
}
function registerReadTool(result: unknown = { content: 'Actual file text' }) {
  const execute = vi.fn(async () => result)
  const tool = {
    name: 'fs_read',
    description: 'Read file',
    category: 'project',
    mutating: false,
    requiresApproval: false,
    effects: ['read'],
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute,
  }
  mocks.getTool.mockImplementation(name => (name === 'fs_read' ? tool : undefined))
  mocks.descriptors.mockReturnValue([
    { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } },
  ])
  return execute
}

describe('goal reports in the real agent loop', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.hud.killSwitch = false
    mocks.descriptors.mockReturnValue([])
    mocks.stream.mockResolvedValue(finalResponse())
  })

  it('keeps the tool off and rejects a model-invented report without a root goal', async () => {
    const execute = vi.fn()
    mocks.getTool.mockReturnValue({ name: 'goal_report', execute })
    mocks.stream.mockResolvedValueOnce(toolResponse({ status: 'completed', summary: 'Invented', evidence: 'Invented' }))
    const result = await runAgent(options())
    expect(offered(mocks.stream.mock.calls[0]![0])).not.toContain('goal_report')
    expect(result.toolFailures).toBe(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([{ disabledTools: ['goal_report'] }, { toolAccess: 'none' as const }])(
    'rejects an unoffered report despite tracking',
    async constraint => {
      const report = vi.fn()
      mocks.stream.mockResolvedValueOnce(toolResponse({ status: 'candidate', summary: 'Ready' }))
      const result = await runAgent(options({ goalTracking: { phase: 'work', report }, ...constraint }))
      expect(offered(mocks.stream.mock.calls[0]![0])).not.toContain('goal_report')
      expect(result.toolFailures).toBe(1)
      expect(report).not.toHaveBeenCalled()
    }
  )

  it('offers a candidate report in read-only mode, applies schema checks and redacts audit output', async () => {
    const report = vi.fn()
    mocks.stream.mockResolvedValueOnce(
      toolResponse({ status: 'candidate', summary: 'PRIVATE SUMMARY', evidence: 'PRIVATE EVIDENCE' })
    )
    const result = await runAgent(options({ toolAccess: 'read-only', goalTracking: { phase: 'work', report } }))
    const sent = mocks.stream.mock.calls[0]![0] as InferenceRequest
    expect(offered(sent)).toContain('goal_report')
    expect(JSON.stringify(sent.messages)).toContain(GOAL_REPORT_MARKER)
    expect(report).toHaveBeenCalledExactlyOnceWith({
      status: 'candidate',
      summary: 'PRIVATE SUMMARY',
      evidence: 'PRIVATE EVIDENCE',
    })
    expect(result).toMatchObject({ finalText: 'Ergebnis geprüft.', toolSuccesses: 1, ephemeralDataUsed: true })
    expect(result.continuation).toBeUndefined()
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.queue).toHaveBeenCalledWith(
      'goal-project',
      expect.objectContaining({ name: 'goal_report', dataHandling: 'ephemeral' })
    )
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('PRIVATE')
    expect(mocks.audit).toHaveBeenCalledWith(
      'tool.executed',
      expect.objectContaining({ output: null, output_redacted: true })
    )
  })

  it.each([
    { phase: 'work' as const, args: { status: 'completed', summary: 'Done', evidence: 'Tests' } },
    { phase: 'review' as const, args: { status: 'completed', summary: 'Done', evidence: '  ' } },
    { phase: 'review' as const, args: { status: 'completed', summary: 'Done', evidence: 'x'.repeat(4001) } },
  ])('rejects invalid completion through the schema/execution path', async ({ phase, args }) => {
    const report = vi.fn()
    mocks.stream.mockResolvedValueOnce(toolResponse(args))
    const result = await runAgent(options({ goalTracking: { phase, report } }))
    expect(result.toolFailures).toBe(1)
    expect(report).not.toHaveBeenCalled()
  })

  it('reports reviewed completion but still returns an interruption when the final model round fails', async () => {
    const report = vi.fn()
    mocks.stream
      .mockResolvedValueOnce(toolResponse({}, 'goal_read_result', 'read-answer'))
      .mockResolvedValueOnce(
        toolResponse({ status: 'completed', summary: 'Criteria met', evidence: 'Tests 8/8, revision abc123' })
      )
      .mockRejectedValueOnce(new Error('Final round failed'))
    const result = await runAgent(
      options({ goalTracking: { phase: 'review', report, candidateText: 'Public deliverable' } })
    )
    expect(report).toHaveBeenCalledOnce()
    expect(result.interrupted).toBeDefined()
    expect(result.continuation).toBeDefined()
  })

  it('rejects completion with fabricated evidence when no actual read occurred', async () => {
    const report = vi.fn()
    mocks.stream.mockResolvedValueOnce(
      toolResponse({ status: 'completed', summary: 'Done', evidence: 'Unverified claim' })
    )
    const result = await runAgent(options({ goalTracking: { phase: 'review', report } }))
    expect(result.toolFailures).toBe(1)
    expect(report).not.toHaveBeenCalled()
  })

  it.each([true, false])('only successful directly executed reads count as completion evidence (%s)', async success => {
    const report = vi.fn()
    const execute = registerReadTool(success ? { content: 'Verified file' } : { ok: false, error: 'Read failed' })
    mocks.stream
      .mockResolvedValueOnce(toolResponse({}, 'fs_read', 'read-file'))
      .mockResolvedValueOnce(toolResponse({ status: 'completed', summary: 'Checked', evidence: 'File meets criteria' }))
    const result = await runAgent(options({ goalTracking: { phase: 'review', report }, toolAccess: 'read-only' }))
    expect(execute).toHaveBeenCalledOnce()
    expect(report.mock.calls.map(([record]) => record.evidence)).toEqual(success
      ? ['File meets criteria\nGeprüfte Leseaufrufe dieser Runde: fs_read (read-file)'] : [])
    expect(report).toHaveBeenCalledTimes(success ? 1 : 0)
    expect(result.toolFailures).toBe(success ? 0 : 2)
    expect(result.continuation).toBeUndefined()
  })

  it('lets a text-only review inspect the captured deliverable before reporting completion', async () => {
    const report = vi.fn()
    mocks.stream
      .mockResolvedValueOnce(toolResponse({}, 'goal_read_result', 'read-answer'))
      .mockImplementationOnce(async (request: InferenceRequest) => {
        expect(JSON.stringify(request.messages)).toContain('ACTUAL PUBLIC ANSWER')
        return toolResponse({
          status: 'completed',
          summary: 'Answer checked',
          evidence: 'The answer meets the text criteria',
        })
      })
    const result = await runAgent(
      options({
        goalTracking: { phase: 'review', report, candidateText: 'ACTUAL PUBLIC ANSWER' },
        toolAccess: 'read-only',
      })
    )
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ evidence: expect.stringContaining('goal_read_result (read-answer)') })
    )
    expect(result.ephemeralDataUsed).toBe(true)
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('ACTUAL PUBLIC ANSWER')
  })

  it('does not count a child read as the parent independent review observation', async () => {
    const report = vi.fn()
    const execute = registerReadTool()
    mocks.stream
      .mockResolvedValueOnce(
        toolResponse(
          { task: 'Read the document.', role: 'review', target: 'local', tools: ['fs_read'] },
          'agent_assist',
          'assist-read'
        )
      )
      .mockResolvedValueOnce(toolResponse({}, 'fs_read', 'child-read'))
      .mockResolvedValueOnce(finalResponse())
      .mockResolvedValueOnce(toolResponse({ status: 'completed', summary: 'Done', evidence: 'Child did the reading' }))
    const result = await runAgent(options({ agentMode: true, goalTracking: { phase: 'review', report } }))
    expect(execute).toHaveBeenCalledOnce()
    expect(result.toolFailures).toBe(1)
    expect(report).not.toHaveBeenCalled()
  })

  it('does not accept a truncated text read as complete evidence', async () => {
    const report = vi.fn()
    mocks.stream
      .mockResolvedValueOnce(toolResponse({}, 'goal_read_result', 'partial-read'))
      .mockResolvedValueOnce(
        toolResponse({ status: 'completed', summary: 'Claims done', evidence: 'Only the start was read' })
      )
    const result = await runAgent(
      options({ goalTracking: { phase: 'review', report, candidateText: 'x'.repeat(16001) } })
    )
    expect(result.toolFailures).toBe(1)
    expect(report).not.toHaveBeenCalled()
  })

  it('does not add reporting to a fixed approved external request', async () => {
    const report = vi.fn()
    const packet = [{ role: 'user' as const, content: 'Approved packet' }]
    mocks.resolveRoute.mockResolvedValue({
      gateway: { ...gateway, target: 'laravel_proxy' },
      externalOneShot: true,
      replacementMessages: packet,
    })
    await runAgent(options({ inferenceGateway: undefined, goalTracking: { phase: 'review', report } }))
    const sent = mocks.stream.mock.calls[0]![0] as InferenceRequest
    expect(sent.messages).toEqual(packet)
    expect(offered(sent)).toEqual([])
    expect(report).not.toHaveBeenCalled()
  })

  it('does not inherit reporting in an adaptive local child, including a stale instruction', async () => {
    const report = vi.fn()
    mocks.stream
      .mockResolvedValueOnce(
        toolResponse(
          { task: 'Prüfe die Angaben.', role: 'review', target: 'local', tools: [] },
          'agent_assist',
          'assist-1'
        )
      )
      .mockImplementationOnce(async (request: InferenceRequest) => {
        expect(offered(request)).not.toContain('goal_report')
        expect(JSON.stringify(request.messages)).not.toContain(GOAL_REPORT_MARKER)
        return toolResponse({ status: 'candidate', summary: 'Child must not report' }, 'goal_report', 'child-report')
      })
    const result = await runAgent(
      options({
        agentMode: true,
        goalTracking: { phase: 'work', report },
        baseMessages: [
          { role: 'system', content: `${GOAL_REPORT_MARKER} Old instruction` },
          { role: 'user', content: 'Prüfe die Angaben.' },
        ],
      })
    )
    expect(result.finalText).toBe('Ergebnis geprüft.')
    expect(report).not.toHaveBeenCalled()
    expect(mocks.stream).toHaveBeenCalledTimes(4)
  })

  it('clears the root report callback at the explicit team boundary', async () => {
    const report = vi.fn()
    mocks.team.mockResolvedValue({ finalText: 'Team result' })
    await runAgent(options({ forceAgentTeam: true, goalTracking: { phase: 'work', report } }))
    expect(mocks.team.mock.calls[0]![0].goalTracking).toBeUndefined()
    expect(report).not.toHaveBeenCalled()
  })

  it('obeys the execution gate before an in-memory report', async () => {
    const report = vi.fn()
    mocks.stream.mockImplementationOnce(async () => {
      mocks.hud.killSwitch = true
      return toolResponse({ status: 'candidate', summary: 'Must not report after stop' })
    })
    const result = await runAgent(options({ goalTracking: { phase: 'work', report } }))
    expect(result.toolFailures).toBe(1)
    expect(report).not.toHaveBeenCalled()
  })
})
