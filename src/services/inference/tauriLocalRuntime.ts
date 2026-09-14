import { localModelDiagnostics, type RuntimeDiagnostics } from './localModelDiagnostics'
import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import type { HardwareSnapshot } from '@/services/inference/capacity'
import { LocalInferenceError, visibleLocalContent } from '@/services/inference/localModelManager'
import type {
  LocalCatalogBinding,
  LocalRuntimeRequest,
  LocalRuntimeTransport,
  LocalReadinessEvidence,
} from '@/services/inference/localModelManager'
import type {
  LocalModelReleaseManifest,
  NativeManifestVerifier,
  NativeManifestVerification,
} from '@/services/inference/modelManifest'
import type { InferenceResult, WireToolCall } from '@/services/inference/types'
import { readReportedTokenUsage } from '@/services/tokenUsage'
import { localResources, type LocalResourceConfigState } from './resources'
import { readThinkingProgress, type ThinkingBudgetProgress, type ThinkingControlAction } from './thinking'
import { describeLocalFailureDiagnostic, readLocalFailureDiagnostic, type LocalFailureDiagnostic } from './localFailure'

type NativeErrorEvent = {
  type: 'error'
  requestId: string
  code: string
  retryable: boolean
  diagnostic?: unknown
}

type NativeInferenceEvent =
  | { type: 'started'; requestId: string }
  | { type: 'delta'; requestId: string; content: string }
  | NativeErrorEvent
  | (ThinkingBudgetProgress & { type: 'budget' })
type ActiveBudget = { request: LocalRuntimeRequest; latest: ThinkingBudgetProgress | null }

const activeBudgets = new Map<string, ActiveBudget>()
function publishBudget(active: ActiveBudget, value: unknown) {
  const progress = readThinkingProgress(value)
  if (
    !progress ||
    progress.requestId !== active.request.requestId ||
    active.request.signal?.aborted ||
    activeBudgets.get(progress.requestId) !== active ||
    (active.latest && progress.sequence < active.latest.sequence)
  )
    return
  active.latest = progress
  active.request.onBudget?.(progress)
}
/** Called only by the owning main renderer; the mini bridge verifies its view epoch first. */
export async function controlLocalReasoning(
  requestId: string,
  action: ThinkingControlAction,
  expectedSequence: number
) {
  const active = activeBudgets.get(requestId)
  if (
    !active ||
    active.request.signal?.aborted ||
    !active.latest ||
    !Number.isSafeInteger(expectedSequence) ||
    expectedSequence < 0 ||
    !['more', 'answer'].includes(action)
  )
    throw new Error('Diese Modellgeneration kann nicht mehr gesteuert werden.')
  const value = await invoke<ThinkingBudgetProgress>('local_model_reasoning_control', {
    requestId,
    action,
    expectedSequence,
    catalogBinding: active.request.catalogBinding,
  })
  if (activeBudgets.get(requestId) !== active || active.request.signal?.aborted)
    throw new Error('Diese Modellgeneration wurde bereits beendet.')
  const progress = readThinkingProgress(value)
  if (!progress || progress.requestId !== requestId)
    throw new Error('Die Runtime hat keinen gültigen Steuerungsstand bestätigt.')
  publishBudget(active, progress)
  return progress
}

type NativeInferenceResult = {
  content: string
  rawToolCalls: WireToolCall[]
  finishReason: string
  requestId: string
  contextUsage?: InferenceResult['contextUsage']
  usage?: InferenceResult['usage']
  diagnostics?: RuntimeDiagnostics
}

export type NativeResourcePlan = {
  resourceRevision?: number
  requestedMode?: LocalResourceConfigState['requested']['mode']
  schemaVersion: 1
  profile: 'memory_saving' | 'balanced' | 'throughput'
  logicalCores: number
  physicalCores: number | null
  availableLogicalCores: number
  threads: number
  threadsBatch: number
  reservedLogicalCores: number
  totalRamBytes: number
  availableRamBytes: number
  ramHeadroomBytes: number
  batchSize: number
  microBatchSize: number
  contextTokens: number
  mmap: boolean
  loadMode?: 'mmap' | 'buffered' | 'runtime_default'
  parallelSlots: 1
  applied: boolean
  reasonCodes: string[]
}

export type NativeModelStorage = {
  storageType: 'nvme' | 'ssd' | 'hdd' | 'mixed' | 'unknown'
  busTypes: string[]
  fixed: boolean | null
  availableBytes: number | null
  totalBytes: number | null
  reasonCode: string | null
}

export type NativeLocalModelStatus = {
  resourceConfig?: LocalResourceConfigState
  manifestAvailable: boolean
  catalogVersion?: number
  policyVersion?: number
  activeModelId?: string | null
  state: 'unavailable' | 'stopped' | 'starting' | 'ready' | 'busy' | 'cooldown' | 'error'
  reasonCode?: string | null
  readiness: LocalReadinessEvidence[]
  resourcePlan?: NativeResourcePlan | null
  modelStorage?: NativeModelStorage | null
  acceleration?: {
    resourceRevision?: number
    requestedMode?: LocalResourceConfigState['requested']['mode']
    deviceIds?: string[]
    fallbackReasonCode?: string | null
    backend: 'cpu' | 'cuda' | 'vulkan' | 'metal' | 'unknown'
    deviceNames: string[]
    offloadedLayers: number | null
    totalLayers: number | null
    gpuMemoryBytes: number | null
    mode: 'gpu' | 'hybrid' | 'cpu' | 'unknown'
    verified: boolean
    reasonCode: string | null
  } | null
}

let manifestAcceptanceSessionId: string | null = null
let manifestAcceptanceRegistration: Promise<string> | null = null

/** Register this renderer lifetime before any asynchronous manifest fetch. */
export function registerNativeManifestAcceptanceSession(): Promise<string> {
  manifestAcceptanceRegistration ??= (async () => {
    manifestAcceptanceSessionId ??= globalThis.crypto?.randomUUID?.() ?? null
    if (!manifestAcceptanceSessionId) {
      throw new Error('Secure manifest acceptance session generation is unavailable.')
    }
    await invoke('local_model_register_manifest_session', { sessionId: manifestAcceptanceSessionId })
    return manifestAcceptanceSessionId
  })().catch(error => {
    manifestAcceptanceRegistration = null
    throw error
  })
  return manifestAcceptanceRegistration
}

/** Clear the previous native catalog before this generation performs any network work. */
export async function beginNativeManifestAcceptance(acceptanceGeneration: number): Promise<string> {
  if (!Number.isSafeInteger(acceptanceGeneration) || acceptanceGeneration < 1) {
    throw new Error('Native manifest acceptance generation is invalid.')
  }
  const sessionId = await registerNativeManifestAcceptanceSession()
  localModelDiagnostics.clear()
  await invoke('local_model_begin_manifest_acceptance', { sessionId, acceptanceGeneration })
  return sessionId
}

/** Native verification also activates the exact verified catalog for runtime commands. */
export const tauriManifestVerifier: NativeManifestVerifier = {
  verify: (wireEnvelope, acceptance) => {
    const {
      trustDomain,
      acceptanceSessionId,
      acceptanceGeneration,
      expectedSchemaVersion,
      expectedCatalogVersion,
      expectedPolicyVersion,
      expectedKeyId,
    } = acceptance
    if (
      !Number.isSafeInteger(expectedSchemaVersion) ||
      !Number.isSafeInteger(expectedCatalogVersion) ||
      !Number.isSafeInteger(expectedPolicyVersion)
    ) {
      throw new Error('Native manifest verification requires exact bootstrap discovery versions.')
    }
    return invoke<NativeManifestVerification>('local_model_verify_manifest', {
      envelope: wireEnvelope,
      acceptance: {
        expectedSchemaVersion,
        expectedCatalogVersion,
        expectedPolicyVersion,
        expectedKeyId,
        expectedTrustDomain: trustDomain,
        expectedAcceptanceSessionId: acceptanceSessionId,
        expectedAcceptanceGeneration: acceptanceGeneration,
      },
    })
  },
}

export async function getNativeLocalModelStatus(): Promise<NativeLocalModelStatus> {
  if (!isTauri()) {
    throw new Error(
      'Lokale Modelle benötigen die native Luczor-App. In einer Browser-Vorschau ist keine lokale Runtime verfügbar.'
    )
  }
  return invoke<NativeLocalModelStatus>('local_model_status')
}

export { getLocalResourceHardware as getNativeHardwareSnapshot } from './resources'

export async function recoverNativeModelMemory(): Promise<HardwareSnapshot> {
  if (!isTauri()) {
    throw new Error(
      'Lokale Modelle benötigen die native Luczor-App. In einer Browser-Vorschau ist keine lokale Runtime verfügbar.'
    )
  }
  return invoke<HardwareSnapshot>('local_model_recover_memory')
}

export async function prepareNativeLocalModel(
  modelReleaseId: string,
  catalogBinding: LocalCatalogBinding
): Promise<LocalReadinessEvidence> {
  if (!isTauri()) {
    throw new Error(
      'Lokale Modelle benötigen die native Luczor-App. In einer Browser-Vorschau ist keine lokale Runtime verfügbar.'
    )
  }
  const resourceRevision = (await localResources.get()).appliedRevision
  return invoke<LocalReadinessEvidence>('local_model_prepare', { modelReleaseId, catalogBinding, resourceRevision })
}

/** Actual OpenAI-compatible llama.cpp path; endpoint, API key and files stay native. */
export class TauriLocalRuntimeTransport implements LocalRuntimeTransport {
  prepare(
    modelReleaseId: string,
    catalogBinding: LocalCatalogBinding,
    resourceRevision = 0
  ): Promise<LocalReadinessEvidence> {
    if (!isTauri()) {
      throw new Error(
        'Lokale Modelle benötigen die native Luczor-App. In einer Browser-Vorschau ist keine lokale Runtime verfügbar.'
      )
    }
    return invoke<LocalReadinessEvidence>('local_model_prepare', {
      modelReleaseId,
      catalogBinding,
      resourceRevision,
      residentOnly: true,
    })
  }

  async stream(_release: LocalModelReleaseManifest, request: LocalRuntimeRequest): Promise<InferenceResult> {
    if (!isTauri()) {
      throw new Error(
        'Lokale Modelle benötigen die native Luczor-App. In einer Browser-Vorschau ist keine lokale Runtime verfügbar.'
      )
    }
    const observation = localModelDiagnostics.begin(request.modelReleaseId, request.messages)
    const channel = new Channel<NativeInferenceEvent>()
    let accumulated = ''
    let nativeFailure:
      | {
          code: LocalFailureDiagnostic['code']
          retryable: boolean
          diagnostic?: LocalFailureDiagnostic
        }
      | undefined
    const budget: ActiveBudget = { request, latest: null }
    activeBudgets.set(request.requestId, budget)
    channel.onmessage = event => {
      if (activeBudgets.get(request.requestId) !== budget || request.signal?.aborted) return
      if (event.requestId && event.requestId !== request.requestId) return
      if (event.type === 'budget') publishBudget(budget, event)
      if (event.type === 'error' && event.requestId === request.requestId && !nativeFailure) {
        const diagnostic = readLocalFailureDiagnostic(event.diagnostic)
        const recognized = readLocalFailureDiagnostic({
          schemaVersion: 1,
          stage: 'unknown',
          code: event.code,
          reason: 'unclassified',
        })
        if (recognized) {
          nativeFailure = {
            code: recognized.code,
            retryable: event.retryable === true,
            ...(diagnostic?.code === recognized.code ? { diagnostic } : {}),
          }
        }
      }
      if (event.type === 'delta') {
        if (request.signal?.aborted) return
        accumulated += event.content
        observation.delta(accumulated)
        request.onToken?.(accumulated)
      }
    }

    const result = await invoke<NativeInferenceResult>('local_model_infer', {
      request: {
        requestId: request.requestId,
        scopeDigest: request.scopeDigest,
        modelReleaseId: request.modelReleaseId,
        catalogBinding: request.catalogBinding,
        resourceRevision: request.resourceRevision ?? 0,
        useCase: request.taskType ?? 'chat.general',
        messages: request.messages,
        tools: request.tools ?? [],
        toolChoice: request.toolChoice ?? 'auto',
        maxOutputTokens: request.maxOutputTokens,
        contextLimit: request.contextLimit,
        reasoningMode: request.reasoningMode ?? 'auto',
        thinkingTier: request.thinkingTier ?? 'balanced',
        thinkingConfig: request.thinkingConfig,
      },
      onEvent: channel,
    })
      .catch(error => {
        const cancelled = request.signal?.aborted === true
        observation.fail(cancelled, cancelled ? undefined : nativeFailure?.diagnostic)
        if (cancelled) throw error
        const partialOutput = visibleLocalContent(accumulated).length > 0
        if (nativeFailure?.diagnostic) {
          throw new LocalInferenceError(
            describeLocalFailureDiagnostic(nativeFailure.diagnostic),
            nativeFailure.code,
            nativeFailure.retryable,
            partialOutput,
            nativeFailure.diagnostic
          )
        }
        if (
          nativeFailure?.code === 'runtime_output_repeated' ||
          String(error) === 'Local generation interrupted after repeated output.'
        ) {
          throw new LocalInferenceError(
            describeLocalFailureDiagnostic({
              schemaVersion: 1,
              stage: 'generation',
              reason: 'unclassified',
              code: 'runtime_output_repeated',
            }),
            'runtime_output_repeated',
            false,
            partialOutput
          )
        }
        if (
          nativeFailure?.code === 'runtime_reasoning_control_unavailable' ||
          String(error) === 'Local thinking control was not confirmed; generation interrupted.'
        ) {
          throw new LocalInferenceError(
            'Die Runtime hat den Abschluss der Denkphase nicht bestätigt. Die Generation wurde an der Budgetgrenze unterbrochen. Der öffentliche Fortschritt bleibt erhalten; das Modell bleibt geladen.',
            'runtime_reasoning_control_unavailable',
            false,
            partialOutput
          )
        }
        if (
          nativeFailure?.code === 'runtime_tool_contract_rejected' ||
          String(error) === 'Local generation returned an invalid tool completion.' ||
          /^Local llama\.cpp rejected the tool contract \(HTTP (400|500)\)\.$/.test(String(error))
        ) {
          throw new LocalInferenceError(
            'Das lokale Modell konnte die Werkzeugdaten nicht verarbeiten. Bereits ausgeführte Aktionen bleiben erhalten. Das Modell bleibt geladen.',
            'runtime_tool_contract_rejected',
            false,
            partialOutput
          )
        }
        if (
          nativeFailure?.code === 'runtime_chat_history_rejected' ||
          /^Local llama\.cpp rejected the conversation role order in its chat template \(HTTP (400|500)\)\.$/.test(
            String(error)
          )
        ) {
          throw new LocalInferenceError(
            'Das lokale Modell konnte die Nachrichtenstruktur nicht verarbeiten. Bitte die Anfrage erneut senden. Das Modell bleibt geladen.',
            'runtime_chat_history_rejected',
            false,
            partialOutput
          )
        }
        if (
          nativeFailure?.code === 'runtime_context_exceeded' ||
          String(error) === 'Local llama.cpp rejected the request because the context window was exceeded (HTTP 400).'
        ) {
          throw new LocalInferenceError(
            'Der aktuelle Auftrag passt auch nach der Kontextanpassung nicht vollständig in das lokale Modell. Bitte große Inhalte als Datei abschnittsweise bearbeiten lassen. Das Modell bleibt geladen.',
            'runtime_context_exceeded',
            false,
            partialOutput
          )
        }
        if (nativeFailure) {
          // Legacy native events have no measured stage or counters. Do not attach inferred telemetry.
          throw new LocalInferenceError(
            nativeFailure.code === 'runtime_request_rejected' &&
              error === 'Local llama.cpp rejected the request (HTTP 400).'
              ? error
              : describeLocalFailureDiagnostic({
                  schemaVersion: 1,
                  stage: 'unknown',
                  code: nativeFailure.code,
                  reason: 'unclassified',
                }),
            nativeFailure.code,
            nativeFailure.retryable,
            partialOutput
          )
        }
        throw error
      })
      .finally(() => {
        if (activeBudgets.get(request.requestId) === budget) {
          activeBudgets.delete(request.requestId)
          request.onBudget?.(null)
        }
      })
    if (request.signal?.aborted) observation.fail(true)
    else observation.finish(result, result.diagnostics)
    return {
      content: result.content,
      contextUsage: result.contextUsage,
      usage: readReportedTokenUsage(result.usage),
      rawToolCalls: result.rawToolCalls,
      toolCalls: result.rawToolCalls.map(call => {
        let args: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(call.function.arguments)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
        } catch {
          // The agent loop receives an empty object and the raw arguments for audit.
        }
        return {
          id: call.id,
          name: call.function.name,
          arguments: args,
          rawArguments: call.function.arguments,
        }
      }),
      finishReason: result.finishReason,
      requestId: result.requestId,
      model: request.modelReleaseId,
      provider: 'local',
      target: 'local_llama_cpp',
      useCase: request.taskType ?? 'chat.general',
    }
  }

  cancel(requestId: string, catalogBinding: LocalCatalogBinding): Promise<void> {
    if (!isTauri()) {
      return Promise.resolve()
    }
    return invoke('local_model_cancel', { requestId, catalogBinding })
  }

  stop(modelReleaseId: string, catalogBinding: LocalCatalogBinding): Promise<void> {
    if (!isTauri()) {
      return Promise.resolve()
    }
    return invoke('local_model_stop', { modelReleaseId, catalogBinding })
  }
}
