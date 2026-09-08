import { Channel, invoke } from '@tauri-apps/api/core'
import type { HardwareSnapshot } from '@/services/inference/capacity'
import { LocalInferenceError } from '@/services/inference/localModelManager'
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

type NativeInferenceEvent =
  | { type: 'started'; requestId: string }
  | { type: 'delta'; requestId: string; content: string }
  | { type: 'error'; requestId: string; code: string; retryable: boolean }

type NativeInferenceResult = {
  content: string
  rawToolCalls: WireToolCall[]
  finishReason: string
  requestId: string
  contextUsage?: InferenceResult['contextUsage']
  usage?: InferenceResult['usage']
}

export type NativeLocalModelStatus = {
  manifestAvailable: boolean
  catalogVersion?: number
  policyVersion?: number
  activeModelId?: string | null
  state: 'unavailable' | 'stopped' | 'starting' | 'ready' | 'busy' | 'cooldown' | 'error'
  reasonCode?: string | null
  readiness: LocalReadinessEvidence[]
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
  return invoke<NativeLocalModelStatus>('local_model_status')
}

export async function getNativeHardwareSnapshot(): Promise<HardwareSnapshot> {
  return invoke<HardwareSnapshot>('local_model_hardware_snapshot')
}

export async function recoverNativeModelMemory(): Promise<HardwareSnapshot> {
  return invoke<HardwareSnapshot>('local_model_recover_memory')
}

export async function prepareNativeLocalModel(
  modelReleaseId: string,
  catalogBinding: LocalCatalogBinding
): Promise<LocalReadinessEvidence> {
  return invoke<LocalReadinessEvidence>('local_model_prepare', { modelReleaseId, catalogBinding })
}

/** Actual OpenAI-compatible llama.cpp path; endpoint, API key and files stay native. */
export class TauriLocalRuntimeTransport implements LocalRuntimeTransport {
  async stream(_release: LocalModelReleaseManifest, request: LocalRuntimeRequest): Promise<InferenceResult> {
    const channel = new Channel<NativeInferenceEvent>()
    let accumulated = ''
    let contextRejected = false
    let historyRejected = false
    let toolContractRejected = false
    channel.onmessage = event => {
      if (event.type === 'error' && event.code === 'runtime_context_exceeded') contextRejected = true
      if (event.type === 'error' && event.code === 'runtime_chat_history_rejected') historyRejected = true
      if (event.type === 'error' && event.code === 'runtime_tool_contract_rejected') toolContractRejected = true
      if (event.type === 'delta') {
        if (request.signal?.aborted) return
        accumulated += event.content
        request.onToken?.(accumulated)
      }
    }

    const result = await invoke<NativeInferenceResult>('local_model_infer', {
      request: {
        requestId: request.requestId,
        scopeDigest: request.scopeDigest,
        modelReleaseId: request.modelReleaseId,
        catalogBinding: request.catalogBinding,
        useCase: request.taskType ?? 'chat.general',
        messages: request.messages,
        tools: request.tools ?? [],
        toolChoice: request.toolChoice ?? 'auto',
        maxOutputTokens: request.maxOutputTokens ?? 2_048,
        contextLimit: request.contextLimit,
        reasoningMode: request.reasoningMode ?? 'auto',
      },
      onEvent: channel,
    }).catch(error => {
      if (
        toolContractRejected ||
        /^Local llama\.cpp rejected the tool contract \(HTTP (400|500)\)\.$/.test(String(error))
      ) {
        throw new LocalInferenceError(
          'Das lokale Modell konnte die Werkzeugdaten nicht verarbeiten. Bereits ausgeführte Aktionen bleiben erhalten. Das Modell bleibt geladen.',
          'runtime_tool_contract_rejected',
          false,
          false
        )
      }
      if (
        historyRejected ||
        /^Local llama\.cpp rejected the conversation role order in its chat template \(HTTP (400|500)\)\.$/.test(
          String(error)
        )
      ) {
        throw new LocalInferenceError(
          'Das lokale Modell konnte die Nachrichtenstruktur nicht verarbeiten. Bitte die Anfrage erneut senden. Das Modell bleibt geladen.',
          'runtime_chat_history_rejected',
          false,
          false
        )
      }
      if (
        contextRejected ||
        String(error) === 'Local llama.cpp rejected the request because the context window was exceeded (HTTP 400).'
      ) {
        throw new LocalInferenceError(
          'Der aktuelle Auftrag passt auch nach der Kontextanpassung nicht vollständig in das lokale Modell. Bitte große Inhalte als Datei abschnittsweise bearbeiten lassen. Das Modell bleibt geladen.',
          'runtime_context_exceeded',
          false,
          false
        )
      }
      throw error
    })
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
    return invoke('local_model_cancel', { requestId, catalogBinding })
  }

  stop(modelReleaseId: string, catalogBinding: LocalCatalogBinding): Promise<void> {
    return invoke('local_model_stop', { modelReleaseId, catalogBinding })
  }
}
