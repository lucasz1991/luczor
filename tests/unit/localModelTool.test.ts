import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executionGate, updateExecutionControls } from '@/services/executionGate'
import type { LocalModelStatusView } from '@/services/localModelStatus'
import { localModelToolDependencies, localModelTools } from '@/services/tools/localModel'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), reconcile: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true, Channel: class {} }))
vi.mock('@/services/inference/coordinator', () => ({
  localInferenceCoordinator: {
    status: () => ({ mode: 'unavailable', reason: 'no_policy', manifest: null, admissions: [] }),
    reconcileNativeStatus: mocks.reconcile,
  },
  localPolicyDiagnostic: () => ({ message: 'Die Modellrichtlinie fehlt.' }),
}))

const tool = localModelTools[0]!
const context = { projectId: 'unbound-project', inferenceTarget: 'local' as const }
const defaultRead = localModelToolDependencies.readStatus
const status = (): LocalModelStatusView => ({
  state: 'ready',
  label: 'Einsatzbereit',
  detail: 'Dateien und gespeicherte Bereitschaft sind bestätigt.',
  modelName: 'Fixture Modell',
  modelId: 'fixture-model',
  prepared: true,
  operational: true,
  checkedAtMs: 123,
  checks: [
    { label: 'Modellberechnung', value: 'GPU · CUDA', verified: true },
    { label: 'GPU-Auslagerung', value: '66 / 66 Modellschichten', verified: true },
  ],
})

beforeEach(() => {
  updateExecutionControls({ mode: 'observe', killSwitch: false, scope: context.projectId })
  mocks.invoke.mockResolvedValue(undefined)
  vi.clearAllMocks()
})
afterEach(() => {
  localModelToolDependencies.readStatus = defaultRead
  vi.unstubAllGlobals()
})

describe('local model diagnostic tool', () => {
  it('reads only constrained native status without loading, inference or an HTTP probe', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('Unexpected HTTP')))
    vi.stubGlobal('fetch', fetch)
    mocks.invoke.mockResolvedValue({ manifestAvailable: false, state: 'unavailable', readiness: [] })
    const result = await tool.execute({}, context)
    expect(result).toMatchObject({
      target: 'local',
      state: 'blocked',
      model_id: null,
      prepared: false,
      operational: false,
      health_probe_performed: false,
      inference_performed: false,
      answer_verified: false,
    })
    expect(mocks.invoke.mock.calls.filter(([command]) => command !== 'execution_gate_update')).toEqual([
      ['local_model_status'],
    ])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains measured offload while exposing only the selected public fields', async () => {
    localModelToolDependencies.readStatus = vi.fn(async () => ({
      ...status(),
      endpoint: 'http://localhost:12345',
      apiKey: 'PRIVATE_RUNTIME_KEY',
      prompt: 'PRIVATE_PROMPT',
      resourceConfig: {
        requested: {
          mode: 'cpu' as const,
          gpuDeviceIds: ['PRIVATE_DEVICE_ID'],
          threads: null,
          threadsBatch: null,
          ramReserveBytes: null,
          vramReserveBytes: null,
        },
        applied: {
          mode: 'gpu' as const,
          gpuDeviceIds: ['PRIVATE_DEVICE_ID'],
          threads: null,
          threadsBatch: null,
          ramReserveBytes: null,
          vramReserveBytes: null,
        },
        revision: 2,
        appliedRevision: 1,
        pending: true,
        reasonCode: null,
      },
    }))
    const result = await tool.execute({}, context)
    expect(result).toMatchObject({
      model_id: 'fixture-model',
      state: 'ready',
      checks: status().checks,
      resources: { requested_mode: 'cpu', applied_mode: 'gpu', revision: 2, applied_revision: 1, change_pending: true },
    })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|localhost/)
    expect(tool).toMatchObject({
      mutating: false,
      requiresApproval: false,
      dataHandling: 'ephemeral',
      effects: ['read'],
    })
  })

  it('masks native failure details and reports unavailable instead of inventing readiness', async () => {
    mocks.invoke.mockRejectedValue(new Error('PRIVATE_RUNTIME_KEY at C:/private/model.gguf'))
    const result = await tool.execute({}, context)
    expect(result).toMatchObject({ state: 'unavailable', prepared: false, operational: false, model_id: null })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private\/model/)
  })

  it('keeps unknown GPU use unknown and never substitutes CPU or a successful answer', async () => {
    const view = status()
    view.checks = [{ label: 'Modellberechnung', value: 'GPU-/CPU-Nutzung noch nicht bestätigt', verified: false }]
    localModelToolDependencies.readStatus = vi.fn(async () => view)
    expect(await tool.execute({}, context)).toMatchObject({ checks: view.checks, answer_verified: false })
  })

  it('rejects arbitrary URLs, native commands and external model access before any read', async () => {
    const read = vi.fn(async () => status())
    localModelToolDependencies.readStatus = read
    for (const args of [
      { url: 'http://localhost:8080/health' },
      { command: 'local_model_prepare' },
      { model_id: 'other' },
    ])
      await expect(tool.execute(args, context)).rejects.toThrow('keine Parameter')
    await expect(tool.execute({}, { ...context, inferenceTarget: 'external' })).rejects.toThrow('lokalen Modellrunde')
    expect(read).not.toHaveBeenCalled()
  })

  it('discards a late status after scope invalidation or caller cancellation', async () => {
    localModelToolDependencies.readStatus = vi.fn(async () => {
      executionGate.invalidate()
      return status()
    })
    await expect(tool.execute({}, context)).rejects.toThrow('Ausführung verworfen')
    const controller = new AbortController()
    localModelToolDependencies.readStatus = vi.fn(async () => {
      controller.abort()
      return status()
    })
    await expect(tool.execute({}, { ...context, signal: controller.signal })).rejects.toThrow()
  })
})
