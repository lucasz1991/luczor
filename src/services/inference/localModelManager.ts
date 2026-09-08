import type { InferenceGateway, InferenceRequest, InferenceResult } from '@/services/inference/types'
import type { LocalModelReleaseManifest } from '@/services/inference/modelManifest'
import { stripReasoningBlocks } from '@/services/publicAnswerStream'

export type LocalRuntimeState = 'stopped' | 'ready' | 'busy' | 'degraded' | 'cooldown' | 'error'

export type LocalModelHealth = {
  modelReleaseId: string
  state: LocalRuntimeState
  consecutiveFailures: number
  cooldownUntil?: string
  lastErrorCode?: string
  updatedAt: string
}

export type LocalReadinessEvidence = {
  resourceRevision?: number
  modelReleaseId: string
  manifestPayloadSha256: string
  artifactSha256: string
  runtimeSha256: string
  ready: boolean
  verifiedAtMs: number
  validUntilMs: number
}

export type LocalCatalogBinding = Readonly<{
  acceptanceSessionId: string
  acceptanceGeneration: number
  manifestPayloadSha256: string
}>

export type LocalRuntimeRequest = InferenceRequest & {
  resourceRevision?: number
  requestId: string
  modelReleaseId: string
  scopeDigest: string
  catalogBinding: LocalCatalogBinding
  maxOutputTokens?: number
  contextLimit?: number
  reasoningMode?: 'auto' | 'off'
}

export interface LocalRuntimeTransport {
  prepare?(
    modelReleaseId: string,
    catalogBinding: LocalCatalogBinding,
    resourceRevision?: number
  ): Promise<LocalReadinessEvidence>
  stream(release: LocalModelReleaseManifest, request: LocalRuntimeRequest): Promise<InferenceResult>
  cancel(requestId: string, catalogBinding: LocalCatalogBinding): Promise<void>
  stop(modelReleaseId: string, catalogBinding: LocalCatalogBinding): Promise<void>
}

export class LocalInferenceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly partialOutput: boolean
  ) {
    super(message)
    this.name = 'LocalInferenceError'
  }
}

function nowIso(now: () => Date): string {
  return now().toISOString()
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

/** Removes Qwen-compatible thinking blocks before any content reaches UI/history. */
export function visibleLocalContent(content: string): string {
  return stripReasoningBlocks(String(content ?? '')).trimStart()
}

const SAFE_NATIVE_RUNTIME_FAILURES = [
  /^Local llama\.cpp returned HTTP [45]\d{2}\.$/,
  /^Local llama\.cpp request failed\.$/,
  /^Local llama\.cpp response exceeded the native size limit\.$/,
  /^Local llama\.cpp emitted invalid UTF-8\.$/,
  /^Local llama\.cpp emitted invalid SSE JSON\.$/,
  /^Local llama\.cpp content exceeded the native size limit\.$/,
  /^Local llama\.cpp stream ended without a terminal marker\.$/,
  /^Local llama\.cpp stream failed\.$/,
  /^Local llama\.cpp SSE line exceeded the native limit\.$/,
  /^Local llama\.cpp (?:rejected the request because the context window was exceeded|rejected the conversation role order in its chat template|could not apply the chat template|rejected the tool contract|has insufficient runtime capacity|rejected native authentication|could not resolve the requested model|rejected the request|reported an internal server error) \(HTTP [45]\d{2}\)\.$/,
] as const

function safeNativeRuntimeFailure(error: unknown): string | undefined {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  return SAFE_NATIVE_RUNTIME_FAILURES.some(pattern => pattern.test(message)) ? message : undefined
}

export class LocalModelManager {
  private readonly health = new Map<string, LocalModelHealth>()
  private readonly active = new Map<string, { controller: AbortController; catalogBinding: LocalCatalogBinding }>()
  private readonly waiters: Array<{
    epoch: number
    signal?: AbortSignal
    onAbort?: () => void
    resolve: () => void
    reject: (reason: unknown) => void
  }> = []
  private slotOccupied = false
  private boundaryEpoch = 0

  constructor(
    private readonly transport: LocalRuntimeTransport,
    private readonly now: () => Date = () => new Date(),
    private readonly requestIdFactory: () => string = () => crypto.randomUUID()
  ) {}

  getHealth(release: LocalModelReleaseManifest): LocalModelHealth {
    const current = this.health.get(release.id)
    if (!current) {
      return {
        modelReleaseId: release.id,
        state: 'stopped',
        consecutiveFailures: 0,
        updatedAt: nowIso(this.now),
      }
    }
    if (current.state === 'cooldown' && current.cooldownUntil) {
      if (Date.parse(current.cooldownUntil) <= this.now().getTime()) {
        const recovered: LocalModelHealth = {
          ...current,
          state: 'degraded',
          cooldownUntil: undefined,
          updatedAt: nowIso(this.now),
        }
        this.health.set(release.id, recovered)
        return { ...recovered }
      }
    }
    return { ...current }
  }

  /** Abort old JS turns before the native catalog/session boundary rotates. */
  invalidateCatalogBoundary(): void {
    this.boundaryEpoch += 1
    for (const [requestId, active] of this.active) {
      active.controller.abort()
      void this.transport.cancel(requestId, active.catalogBinding).catch(() => undefined)
    }
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.reject(
        new LocalInferenceError(
          'Die wartende lokale Route gehört zu einer abgelaufenen Kataloggrenze.',
          'catalog_binding_stale',
          false,
          false
        )
      )
    }
    this.health.clear()
  }

  /** Called after the native workflow barrier has applied new resource settings. */
  invalidateResourceBoundary(): void {
    if (this.active.size || this.slotOccupied || this.waiters.length) throw new Error('resource_config_busy')
    this.boundaryEpoch += 1
    this.health.clear()
  }

  gateway(
    release: LocalModelReleaseManifest,
    readiness: LocalReadinessEvidence,
    catalogBinding: LocalCatalogBinding,
    scopeDigest: string
  ): InferenceGateway {
    const fixedBinding = Object.freeze({ ...catalogBinding })
    const gatewayEpoch = this.boundaryEpoch
    const lease = { current: { ...readiness } }
    return Object.freeze({
      id: `local:${release.id}`,
      target: 'local_llama_cpp' as const,
      streamChatWithTools: (request: InferenceRequest) =>
        this.stream(release, lease, fixedBinding, scopeDigest, gatewayEpoch, request),
    })
  }

  async cancel(requestId: string, catalogBinding: LocalCatalogBinding): Promise<void> {
    const active = this.active.get(requestId)
    active?.controller.abort()
    await this.transport.cancel(requestId, active?.catalogBinding ?? catalogBinding)
  }

  async stop(release: LocalModelReleaseManifest, catalogBinding: LocalCatalogBinding): Promise<void> {
    for (const [requestId, active] of this.active) {
      active.controller.abort()
      await this.transport.cancel(requestId, active.catalogBinding).catch(() => undefined)
    }
    await this.transport.stop(release.id, catalogBinding)
    this.health.set(release.id, {
      modelReleaseId: release.id,
      state: 'stopped',
      consecutiveFailures: 0,
      updatedAt: nowIso(this.now),
    })
  }

  private async stream(
    release: LocalModelReleaseManifest,
    lease: { current: LocalReadinessEvidence },
    catalogBinding: LocalCatalogBinding,
    scopeDigest: string,
    gatewayEpoch: number,
    request: InferenceRequest
  ): Promise<InferenceResult> {
    const slot = this.acquireSlot(gatewayEpoch, request.signal)
    if (slot !== true) await slot
    try {
      return await this.streamExclusive(release, lease, catalogBinding, scopeDigest, gatewayEpoch, request)
    } finally {
      this.releaseSlot()
    }
  }

  private async streamExclusive(
    release: LocalModelReleaseManifest,
    lease: { current: LocalReadinessEvidence },
    catalogBinding: LocalCatalogBinding,
    scopeDigest: string,
    gatewayEpoch: number,
    request: InferenceRequest
  ): Promise<InferenceResult> {
    if (gatewayEpoch !== this.boundaryEpoch) {
      throw new LocalInferenceError(
        'Die lokale Route gehört zu einer abgelaufenen Kataloggrenze.',
        'catalog_binding_stale',
        false,
        false
      )
    }
    if (!release.enabled || release.executionTarget !== 'local_llama_cpp' || !release.artifact || !release.runtime) {
      throw new LocalInferenceError(
        'Das lokale Modellrelease ist nicht ausführbar.',
        'release_unavailable',
        false,
        false
      )
    }
    const previous = this.getHealth(release)
    if (previous.state === 'cooldown') {
      throw new LocalInferenceError(
        'Das lokale Modell befindet sich in der Abkühlphase.',
        'model_cooldown',
        true,
        false
      )
    }
    if (!/^[a-f0-9]{64}$/.test(scopeDigest)) {
      throw new LocalInferenceError('Der lokale Scope-Digest ist ungültig.', 'scope_invalid', false, false)
    }
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        catalogBinding.acceptanceSessionId
      ) ||
      !Number.isSafeInteger(catalogBinding.acceptanceGeneration) ||
      catalogBinding.acceptanceGeneration < 1 ||
      !/^[a-f0-9]{64}$/.test(catalogBinding.manifestPayloadSha256)
    ) {
      throw new LocalInferenceError('Die lokale Katalogbindung ist ungültig.', 'catalog_binding_invalid', false, false)
    }
    let readiness = lease.current
    // A long agent turn retains its gateway. Renew an expired native lease only
    // after acquiring the model slot; never extend a timestamp in the renderer.
    const matchesRelease = (evidence: LocalReadinessEvidence) =>
      (evidence.resourceRevision ?? 0) === (lease.current.resourceRevision ?? 0) &&
      evidence.ready &&
      evidence.modelReleaseId === release.id &&
      evidence.manifestPayloadSha256 === catalogBinding.manifestPayloadSha256 &&
      evidence.artifactSha256 === release.artifact!.sha256 &&
      evidence.runtimeSha256 === release.runtime!.sha256 &&
      Number.isFinite(evidence.validUntilMs)
    if (matchesRelease(readiness) && readiness.validUntilMs <= this.now().getTime() && this.transport.prepare) {
      if (request.signal?.aborted) throw abortError()
      try {
        readiness = await this.transport.prepare(release.id, catalogBinding, lease.current.resourceRevision ?? 0)
      } catch {
        if (request.signal?.aborted) throw abortError()
        if (gatewayEpoch !== this.boundaryEpoch) {
          throw new LocalInferenceError(
            'Die lokale Katalogbindung wurde erneuert.',
            'catalog_binding_stale',
            false,
            false
          )
        }
        throw new LocalInferenceError(
          'Die lokale Bereitschaft konnte nicht erneuert werden. Der bisherige Fortschritt bleibt erhalten.',
          'readiness_refresh_failed',
          true,
          false
        )
      }
      if (request.signal?.aborted) throw abortError()
      if (gatewayEpoch !== this.boundaryEpoch) {
        throw new LocalInferenceError(
          'Die lokale Katalogbindung wurde erneuert.',
          'catalog_binding_stale',
          false,
          false
        )
      }
    }
    if (
      !readiness.ready ||
      (readiness.resourceRevision ?? 0) !== (lease.current.resourceRevision ?? 0) ||
      readiness.modelReleaseId !== release.id ||
      readiness.manifestPayloadSha256 !== catalogBinding.manifestPayloadSha256 ||
      readiness.artifactSha256 !== release.artifact.sha256 ||
      readiness.runtimeSha256 !== release.runtime.sha256 ||
      !Number.isFinite(readiness.validUntilMs) ||
      readiness.validUntilMs <= this.now().getTime()
    ) {
      throw new LocalInferenceError(
        'Lokale Artifact-/Runtime-Readiness fehlt oder ist abgelaufen.',
        'readiness_unavailable',
        false,
        false
      )
    }
    lease.current = { ...readiness }

    const operationEpoch = this.boundaryEpoch
    const requestId = this.requestIdFactory()
    const controller = new AbortController()
    const parentAbort = () => {
      controller.abort()
      // Tauri invoke cannot consume AbortSignal directly. Propagate the abort
      // immediately so native code kills the scope-bound llama.cpp process.
      void this.transport.cancel(requestId, catalogBinding).catch(() => undefined)
    }
    request.signal?.addEventListener('abort', parentAbort, { once: true })
    if (request.signal?.aborted) parentAbort()
    this.active.set(requestId, { controller, catalogBinding })
    let partialOutput = false
    this.health.set(release.id, {
      ...previous,
      modelReleaseId: release.id,
      state: 'busy',
      updatedAt: nowIso(this.now),
    })

    const runtimeRequest: LocalRuntimeRequest = {
      ...request,
      requestId,
      modelReleaseId: release.id,
      scopeDigest,
      resourceRevision: readiness.resourceRevision ?? 0,
      catalogBinding,
      signal: controller.signal,
      onToken: accumulated => {
        if (controller.signal.aborted || operationEpoch !== this.boundaryEpoch) return
        const visible = visibleLocalContent(accumulated)
        partialOutput ||= visible.length > 0
        request.onToken?.(visible)
      },
    }

    try {
      if (controller.signal.aborted) throw abortError()
      const result = await this.transport.stream(release, runtimeRequest)
      if (controller.signal.aborted) throw abortError()
      const visible = visibleLocalContent(result.content)
      if (operationEpoch === this.boundaryEpoch) {
        this.health.set(release.id, {
          modelReleaseId: release.id,
          state: 'ready',
          consecutiveFailures: 0,
          updatedAt: nowIso(this.now),
        })
      }
      return {
        ...result,
        content: visible,
        requestId: result.requestId ?? requestId,
        model: release.id,
        provider: 'local',
        target: 'local_llama_cpp',
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        if (operationEpoch === this.boundaryEpoch) {
          this.health.set(release.id, {
            ...previous,
            modelReleaseId: release.id,
            state: 'ready',
            updatedAt: nowIso(this.now),
          })
        }
        await this.transport.cancel(requestId, catalogBinding).catch(() => undefined)
        throw abortError()
      }

      // Input/template role rejection is not model-health evidence. Native code
      // retains the resident process, so the next valid request stays admissible.
      if (
        error instanceof LocalInferenceError &&
        ['runtime_context_exceeded', 'runtime_chat_history_rejected', 'runtime_tool_contract_rejected'].includes(
          error.code
        )
      ) {
        if (operationEpoch === this.boundaryEpoch) {
          this.health.set(release.id, { ...previous, state: 'ready', updatedAt: nowIso(this.now) })
        }
        throw error
      }
      const failures = previous.consecutiveFailures + 1
      const entersCooldown = failures >= release.healthPolicy.maxConsecutiveFailures
      const cooldownUntil = entersCooldown
        ? new Date(this.now().getTime() + release.healthPolicy.cooldownMs).toISOString()
        : undefined
      const code = error instanceof LocalInferenceError ? error.code : 'runtime_failed'
      if (operationEpoch === this.boundaryEpoch) {
        this.health.set(release.id, {
          modelReleaseId: release.id,
          state: entersCooldown ? 'cooldown' : 'degraded',
          consecutiveFailures: failures,
          cooldownUntil,
          lastErrorCode: code,
          updatedAt: nowIso(this.now),
        })
      }
      if (error instanceof LocalInferenceError) {
        throw new LocalInferenceError(error.message, error.code, error.retryable, partialOutput || error.partialOutput)
      }
      throw new LocalInferenceError(
        safeNativeRuntimeFailure(error) ?? 'Die lokale Runtime ist fehlgeschlagen.',
        code,
        true,
        partialOutput
      )
    } finally {
      request.signal?.removeEventListener('abort', parentAbort)
      this.active.delete(requestId)
    }
  }

  private acquireSlot(epoch: number, signal?: AbortSignal): true | Promise<void> {
    if (signal?.aborted) throw abortError()
    if (!this.slotOccupied) {
      this.slotOccupied = true
      return true
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = { epoch, signal, resolve, reject } as (typeof this.waiters)[number]
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private releaseSlot(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal?.aborted) {
        waiter.reject(abortError())
        continue
      }
      if (waiter.epoch !== this.boundaryEpoch) {
        waiter.reject(
          new LocalInferenceError(
            'Die wartende lokale Route gehört zu einer abgelaufenen Kataloggrenze.',
            'catalog_binding_stale',
            false,
            false
          )
        )
        continue
      }
      waiter.resolve()
      return
    }
    this.slotOccupied = false
  }
}
