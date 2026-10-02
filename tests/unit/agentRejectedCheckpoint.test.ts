import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(),
  getTool: vi.fn(),
  toOpenAITools: vi.fn(),
  scan: vi.fn(),
  navigate: vi.fn(),
  awaitApproval: vi.fn(),
  canAutoExecuteTool: vi.fn(),
  queueToolCall: vi.fn(),
  updateToolCallStatus: vi.fn(),
  addHiddenToolMessage: vi.fn(),
  hud: { killSwitch: false },
}))

vi.mock('@/services/openrouter.service', () => ({
  OpenRouterService: { streamChatWithTools: mocks.streamChatWithTools },
}))
vi.mock('@/services/inference/coordinator', () => ({
  resolveInferenceRouteForTurn: vi.fn(async () => ({
    gateway: { id: 'synthetic', target: 'laravel_proxy', streamChatWithTools: mocks.streamChatWithTools },
  })),
}))
vi.mock('@/services/tools/registry', () => ({ getTool: mocks.getTool, toOpenAITools: mocks.toOpenAITools }))
vi.mock('@/services/approvals', () => ({ awaitApproval: mocks.awaitApproval }))
vi.mock('@/services/executionPolicy', () => ({
  loadExecutionPolicy: vi.fn(async () => ({ autoExecuteMutatingTools: true })),
  canAutoExecuteTool: mocks.canAutoExecuteTool,
}))
vi.mock('@/state/store', () => ({
  mutations: {
    queueToolCall: mocks.queueToolCall,
    updateToolCallStatus: mocks.updateToolCallStatus,
    addHiddenToolMessage: mocks.addHiddenToolMessage,
  },
}))
vi.mock('@/state/hud', () => ({
  hud: mocks.hud,
  setStatus: vi.fn(),
  pulse: vi.fn(),
  setLastTool: vi.fn(),
}))
vi.mock('@/services/api/sync', () => ({ logAgentEvent: vi.fn() }))
vi.mock('@/services/agents/adaptiveAssistance', () => ({ createAdaptiveAssistance: vi.fn() }))
vi.mock('@/services/debugTrace', () => ({
  recordTrace: vi.fn(),
  traceEnabled: vi.fn(async () => false),
  debugScope: vi.fn(async () => 'synthetic-rejected-checkpoint'),
}))

import { runAgent } from '@/services/agent'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import { resumeCheckpointMessages, unresolvedCheckpointCalls } from '@/services/agents/continuationHistory'
import { createMemoryRunArchiveStore, createRunArchive } from '@/services/runs/runArchive'
import { createRunCoordinator } from '@/services/runs/runCoordinator'
import type { InferenceRequest } from '@/services/inference/types'
import type { ToolDef } from '@/services/tools/types'

describe('rejected tool receipts at cancellation boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hud.killSwitch = false
    mocks.canAutoExecuteTool.mockReturnValue(true)
    mocks.awaitApproval.mockResolvedValue(false)
    mocks.scan.mockRejectedValue(new Error('workflow_browser_session_unavailable'))
    const definitions: ToolDef[] = [
      {
        name: 'browser_dom_scan',
        category: 'app',
        description: 'Read a synthetic browser session.',
        parameters: { type: 'object', properties: {} },
        mutating: false,
        requiresApproval: false,
        execute: mocks.scan,
      },
      {
        name: 'browser_navigate',
        category: 'app',
        description: 'Navigate a synthetic browser session.',
        parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        mutating: true,
        requiresApproval: false,
        execute: mocks.navigate,
      },
    ]
    mocks.getTool.mockImplementation(name => definitions.find(tool => tool.name === name))
    mocks.toOpenAITools.mockReturnValue(
      definitions.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
    )
  })

  it.each(['observe', 'approval_denied'] as const)(
    'retains a %s navigation rejection before aborting the next inference and resumes without false uncertainty',
    async rejection => {
      const approvalDenied = rejection === 'approval_denied'
      if (approvalDenied) {
        mocks.getTool('browser_navigate').requiresApproval = true
        mocks.canAutoExecuteTool.mockReturnValue(false)
      }
      const scope = { principalId: 'synthetic', projectId: 'project', conversationId: 'chat', runId: 'run' }
      const store = createMemoryRunArchiveStore()
      const key = async () => 'ab'.repeat(32)
      const archive = createRunArchive({ store, key })
      const saved: AgentCheckpoint[] = []
      const controller = new AbortController()
      const calls = [
        { id: 'scan-before-rejection', name: 'browser_dom_scan', arguments: {} },
        { id: 'rejected-navigation', name: 'browser_navigate', arguments: { url: 'https://example.test/fixture' } },
      ]
      mocks.streamChatWithTools
        .mockResolvedValueOnce({
          content: '',
          toolCalls: calls,
          rawToolCalls: calls.map(call => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        })
        .mockImplementationOnce(async (request: InferenceRequest) => {
          // The rejection exists in live history; it must also be durable before
          // the next cancellable model request can discard this agent invocation.
          const receipt = request.messages.find(
            message => message.role === 'tool' && message.name === 'browser_navigate'
          )!
          expect(JSON.parse(receipt.content)).toMatchObject({
            ok: false,
            error: expect.stringContaining(approvalDenied ? 'Vom Nutzer abgelehnt' : 'Beobachten'),
          })
          controller.abort()
          throw new DOMException('Synthetic user cancellation', 'AbortError')
        })

      await expect(
        runAgent({
          projectId: scope.projectId,
          conversationId: scope.conversationId,
          principalScopeId: scope.principalId,
          runId: scope.runId,
          mode: approvalDenied ? 'act' : 'observe',
          signal: controller.signal,
          baseMessages: [{ role: 'user', content: 'Prüfe den internen Browser.' }],
          maxRounds: 3,
          onCheckpoint: async value => {
            const snapshot = structuredClone(value)
            await archive.capture({ ...scope, messageId: 'assistant', checkpoint: snapshot })
            saved.push(snapshot)
          },
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(mocks.streamChatWithTools).toHaveBeenCalledTimes(2)
      expect(mocks.scan).toHaveBeenCalledOnce()
      expect(mocks.navigate).not.toHaveBeenCalled()
      expect(mocks.awaitApproval).toHaveBeenCalledTimes(approvalDenied ? 1 : 0)
      expect(saved.length).toBeGreaterThan(0)
      const last = saved.at(-1)!
      expect.soft(last.messages).toContainEqual(expect.objectContaining({ role: 'tool', name: 'browser_navigate' }))
      expect.soft(unresolvedCheckpointCalls(last.messages)).toEqual([])
      expect.soft(last.uncertainMutations ?? []).toEqual([])
      expect.soft(JSON.stringify(resumeCheckpointMessages(last.messages))).not.toContain('checkpoint_outcome_unknown')

      const prepared = await createRunCoordinator(createRunArchive({ store, key })).prepareResume({
        ...scope,
        sessionId: 'resumed-session',
        generation: 2,
        review: true,
      })
      expect.soft(prepared.reasons).toEqual([])
      expect.soft(prepared.status).toBe('ready')
      expect.soft(prepared.checkpoint?.toolAccess).toBeUndefined()
      expect.soft(prepared.automaticEligible).toBe(true)
    }
  )
})
