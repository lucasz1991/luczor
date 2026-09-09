import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/services/inference/coordinator', () => ({
  localInferenceCoordinator: { residentOptimizationGateway: vi.fn() },
  resolveInferenceRouteForTurn: vi.fn(),
  packetBoundLaravelGateway: vi.fn(),
  hashInferenceEgressRequest: vi.fn(),
}))
vi.mock('@/services/inference/resources', () => ({ localResources: { runPreemptibleBackground: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'
import { localResources } from '@/services/inference/resources'
import { localInferenceCoordinator, resolveInferenceRouteForTurn } from '@/services/inference/coordinator'
import { executionGate } from '@/services/executionGate'
import { proposeResidentWorkflowRepair } from '@/services/workflows/repairAutomation'
import type { InferenceRequest, InferenceResult } from '@/services/inference/types'

const stream = vi.fn<(request: InferenceRequest) => Promise<InferenceResult>>()
let background: AbortController
beforeEach(() => {
  vi.clearAllMocks()
  background = new AbortController()
  executionGate.update({ mode: 'act', killSwitch: false, scope: crypto.randomUUID() })
  vi.mocked(localResources.runPreemptibleBackground).mockImplementation(async (operation, signal) =>
    operation({ leaseId: 'background', resourceRevision: 1 }, AbortSignal.any([signal, background.signal]))
  )
  vi.mocked(invoke).mockResolvedValue({ state: 'ready', activeModelId: 'resident-model' })
  vi.mocked(localInferenceCoordinator.residentOptimizationGateway).mockResolvedValue({
    id: 'resident',
    target: 'local_llama_cpp',
    streamChatWithTools: stream,
  })
  stream.mockResolvedValue({
    content: '{"changes":[{"step_key":"compute","code":"fixed()"}]}',
    toolCalls: [],
    rawToolCalls: [],
    finishReason: 'stop',
  })
})

describe('resident-only repair proposal', () => {
  it('uses the constrained resident gateway with no tools, external route or preparation command', async () => {
    const ticket = executionGate.capture(new AbortController().signal)
    await expect(
      proposeResidentWorkflowRepair({ failure: [{ error: 'ReferenceError' }] }, 'project-1', ticket)
    ).resolves.toEqual({ changes: [{ step_key: 'compute', code: 'fixed()' }] })
    expect(localResources.runPreemptibleBackground).toHaveBeenCalledOnce()
    expect(localInferenceCoordinator.residentOptimizationGateway).toHaveBeenCalledExactlyOnceWith(
      'project-1',
      'resident-model'
    )
    expect(resolveInferenceRouteForTurn).not.toHaveBeenCalled()
    expect(vi.mocked(invoke).mock.calls.map(call => call[0])).toEqual(['local_model_status'])
    expect(stream.mock.calls[0]?.[0]).toMatchObject({ tools: [], toolChoice: 'none', projectId: 'project-1' })
  })

  it('never starts inference from missing, busy or unverifiable runtime state', async () => {
    for (const status of [
      { state: 'stopped' },
      { state: 'busy', activeModelId: 'resident-model' },
      { state: 'ready' },
    ]) {
      vi.mocked(invoke).mockResolvedValue(status)
      await expect(proposeResidentWorkflowRepair({}, 'project-1', executionGate.capture())).rejects.toThrow(
        'resident_model_unavailable'
      )
    }
    expect(stream).not.toHaveBeenCalled()
    expect(resolveInferenceRouteForTurn).not.toHaveBeenCalled()
  })

  it('propagates foreground preemption to the actual tools-free model request and rejects late output', async () => {
    stream.mockImplementationOnce(async request => {
      background.abort(new Error('resource_background_preempted'))
      expect(request.signal?.aborted).toBe(true)
      return {
        content: '{"changes":[{"step_key":"compute","code":"late()"}]}',
        toolCalls: [],
        rawToolCalls: [],
        finishReason: 'stop',
      }
    })
    await expect(proposeResidentWorkflowRepair({}, 'project-1', executionGate.capture())).rejects.toThrow(
      'resource_background_preempted'
    )
  })

  it('rejects a gateway that unexpectedly routes outside the local runtime', async () => {
    vi.mocked(localInferenceCoordinator.residentOptimizationGateway).mockResolvedValueOnce({
      id: 'external',
      target: 'laravel_proxy',
      streamChatWithTools: stream,
    })
    await expect(proposeResidentWorkflowRepair({}, 'project-1', executionGate.capture())).rejects.toThrow(
      'local_model_required'
    )
    expect(stream).not.toHaveBeenCalled()
  })
})
