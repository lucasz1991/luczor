import { invoke } from '@tauri-apps/api/core'
import type { HardwareSnapshot } from './capacity'

export type ResourcePercentageLimits = { responseCpu: number; contextCpu: number; ram: number; gpu: number }

export type LocalResourceConfig = {
  mode: 'auto' | 'gpu' | 'cpu' | 'hybrid'
  gpuDeviceIds: string[] | null
  threads: number | null
  threadsBatch: number | null
  ramReserveBytes: number | null
  vramReserveBytes: number | null
  /** Optional for compatibility; native admission recalculates from fresh hardware. */
  percentageLimits?: ResourcePercentageLimits
}

export type LocalResourceConfigState = {
  requested: LocalResourceConfig
  applied: LocalResourceConfig
  revision: number
  appliedRevision: number
  pending: boolean
  reasonCode: string | null
}

export const DEFAULT_LOCAL_RESOURCE_CONFIG: Readonly<LocalResourceConfig> = Object.freeze({
  mode: 'auto',
  gpuDeviceIds: null,
  threads: null,
  threadsBatch: null,
  ramReserveBytes: null,
  vramReserveBytes: null,
})

export type LocalResourceWork = Readonly<{ leaseId: string; resourceRevision: number }>
type WorkLease = {
  work: LocalResourceWork
  references: number
  native: boolean
  closing?: boolean
  releaseForeground?: () => void
}
type ForegroundAdmission = (signal?: AbortSignal) => Promise<{ release(): void }>
type DeferredCleanup = {
  lease: WorkLease
  attempts: number
  timer?: ReturnType<typeof setTimeout>
  running?: Promise<void>
}
const CLEANUP_BACKOFF_MS = [1_000, 2_000, 4_000] as const
type ResourceDependencies = {
  enabled(): boolean
  get(): Promise<LocalResourceConfigState>
  set(config: LocalResourceConfig, expectedRevision: number): Promise<LocalResourceConfigState>
  apply(expectedRevision: number): Promise<LocalResourceConfigState>
  begin(leaseId: string): Promise<LocalResourceWork>
  end(leaseId: string): Promise<unknown>
  applied?(state: LocalResourceConfigState): void | Promise<void>
}

function waitForChange(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, 150)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

const pendingError = (error: unknown) =>
  /resource_(?:mode|config|work)_(?:switch_pending|pending|busy)|resource_switch_pending/.test(String(error))

/** A lease covers the entire logical job, including gaps between tool/model rounds. */
export class LocalResourceController {
  private readonly leases = new Map<string, WorkLease>()
  private readonly groups = new Map<string, LocalResourceWork>()
  private readonly cleanups = new Map<string, DeferredCleanup>()
  private readonly listeners = new Set<(state: LocalResourceConfigState) => void>()
  private applying?: Promise<LocalResourceConfigState>
  private retry?: ReturnType<typeof setTimeout>
  private last?: LocalResourceConfigState
  private foregroundAdmission?: ForegroundAdmission
  private foregroundPending = 0
  private modelTransition?: Promise<unknown>
  private preemptibleBackground?: { controller: AbortController; drained: Promise<void> }

  constructor(private readonly dependencies: ResourceDependencies) {}

  /** Main-renderer background owner. The returned disposer only removes its own hook. */
  setForegroundAdmission(admit: ForegroundAdmission): () => void {
    this.foregroundAdmission = admit
    return () => {
      if (this.foregroundAdmission === admit) this.foregroundAdmission = undefined
    }
  }

  hasWork(): boolean {
    return this.leases.size > 0 || this.preemptibleBackground !== undefined || this.foregroundPending > 0
  }

  isModelSwitchPending(): boolean {
    return this.modelTransition !== undefined
  }

  /** Drain whole jobs, then replace the resident model before admitting new jobs. */
  switchModel<T>(operation: () => Promise<T>): Promise<T> {
    // A new selection/retry is an explicit request to reconcile closing jobs.
    this.restartCleanup()
    const previous = this.modelTransition
    const transition = (async () => {
      await previous?.catch(() => undefined)
      const background = this.preemptibleBackground
      background?.controller.abort(new Error('resource_background_preempted'))
      if (background) await background.drained
      while (this.hasWork()) {
        // Never silently wait forever for an exhausted native end acknowledgement.
        // Keep ownership, surface the failure, and allow the UI retry to reconcile it.
        if (
          [...this.cleanups.values()].some(
            job => !job.timer && !job.running && job.attempts >= CLEANUP_BACKOFF_MS.length
          )
        )
          throw new Error('resource_work_cleanup_failed')
        await waitForChange()
      }
      if (this.dependencies.enabled()) await this.flush()
      return operation()
    })()
    this.modelTransition = transition
    const clear = () => {
      if (this.modelTransition === transition) this.modelTransition = undefined
    }
    void transition.then(clear, clear)
    return transition
  }

  private publish(state: LocalResourceConfigState): LocalResourceConfigState {
    if (this.last && (state.revision < this.last.revision || state.appliedRevision < this.last.appliedRevision)) {
      return structuredClone(this.last)
    }
    this.last = structuredClone(state)
    for (const listener of this.listeners) {
      this.notify(listener, state)
    }
    return state
  }

  async get(): Promise<LocalResourceConfigState> {
    return this.publish(await this.dependencies.get())
  }

  /** An explicit UI refresh may retry exhausted cleanup; internal reads never restart it. */
  async refresh(): Promise<LocalResourceConfigState> {
    this.restartCleanup()
    return this.flush()
  }

  async set(config: LocalResourceConfig, expectedRevision: number): Promise<LocalResourceConfigState> {
    this.restartCleanup()
    const state = this.publish(await this.dependencies.set(config, expectedRevision))
    if (!state.pending) return state
    return this.flush()
  }

  async subscribe(listener: (state: LocalResourceConfigState) => void): Promise<() => void> {
    this.listeners.add(listener)
    try {
      if (this.last) this.notify(listener, this.last)
      else await this.get()
    } catch (error) {
      this.listeners.delete(listener)
      throw error
    }
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(listener: (state: LocalResourceConfigState) => void, state: LocalResourceConfigState): void {
    try {
      listener(structuredClone(state))
    } catch {
      /* A view cannot interrupt resource ownership. */
    }
  }

  private async finishLease(lease: WorkLease): Promise<void> {
    const job = this.cleanups.get(lease.work.leaseId)
    if (job?.timer) clearTimeout(job.timer)
    this.cleanups.delete(lease.work.leaseId)
    lease.references = 0
    this.leases.delete(lease.work.leaseId)
    lease.releaseForeground?.()
    // A completed job must retain its result even if applying the next configuration fails.
    if (lease.native && this.last?.pending) await this.flush().catch(() => undefined)
  }

  private async closeLease(lease: WorkLease): Promise<void> {
    if (lease.native) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.dependencies.end(lease.work.leaseId)
          await this.finishLease(lease)
          return
        } catch {
          if (attempt < 2) await waitForChange()
        }
      }
      // The controller now owns the retry, even after a run/team drops its release handle.
      const job: DeferredCleanup = { lease, attempts: 0 }
      this.cleanups.set(lease.work.leaseId, job)
      this.scheduleCleanup(job)
      return
    }
    await this.finishLease(lease)
  }

  private restartCleanup(): void {
    for (const job of this.cleanups.values()) {
      if (job.timer || job.running) continue
      job.attempts = 0
      this.scheduleCleanup(job)
    }
  }

  private scheduleCleanup(job: DeferredCleanup): void {
    if (this.cleanups.get(job.lease.work.leaseId) !== job || job.timer || job.running) return
    const delay = CLEANUP_BACKOFF_MS[job.attempts]
    if (delay === undefined) return
    job.timer = setTimeout(() => {
      job.timer = undefined
      job.attempts += 1
      job.running = (async () => {
        try {
          await this.dependencies.end(job.lease.work.leaseId)
          await this.finishLease(job.lease)
        } catch {
          /* Keep the closing lease until native end is positively confirmed. */
        }
      })()
      void job.running.finally(() => {
        job.running = undefined
        this.scheduleCleanup(job)
      })
    }, delay)
  }

  /** Native also verifies workflow leases and active preparation/inference before replacing its own runtime. */
  async flush(): Promise<LocalResourceConfigState> {
    if (this.applying) return this.applying
    this.applying = (async () => {
      const state = await this.get()
      if (!state.pending || this.leases.size) return state
      try {
        const applied = this.publish(await this.dependencies.apply(state.revision))
        if (!applied.pending && applied.appliedRevision !== state.appliedRevision)
          await this.dependencies.applied?.(applied)
        return applied
      } catch (error) {
        if (!pendingError(error) && !String(error).includes('resource_revision_mismatch')) throw error
        this.scheduleRetry()
        return this.get()
      }
    })()
    try {
      return await this.applying
    } finally {
      this.applying = undefined
    }
  }

  private scheduleRetry(): void {
    if (this.retry) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.flush().catch(() => undefined)
    }, 350)
  }

  group(key: string): LocalResourceWork | undefined {
    return this.groups.get(key)
  }

  async acquireGroup(key: string, signal?: AbortSignal, parent?: LocalResourceWork) {
    const existing = this.groups.get(key)
    const lease = await this.acquire(signal, parent ?? existing)
    if (!existing) this.groups.set(key, lease.work)
    return {
      work: lease.work,
      release: async () => {
        if (!existing && this.groups.get(key) === lease.work) this.groups.delete(key)
        await lease.release()
      },
    }
  }

  async acquire(
    signal?: AbortSignal,
    parent?: LocalResourceWork,
    priority: 'foreground' | 'background' = 'foreground'
  ): Promise<{ work: LocalResourceWork; release(): Promise<void> }> {
    signal?.throwIfAborted()
    const inherited = parent && this.leases.get(parent.leaseId)
    if (parent && (!inherited || inherited.work !== parent || inherited.closing))
      throw new Error('resource_work_parent_expired')
    let lease: WorkLease
    if (inherited) {
      lease = inherited
      lease.references += 1
    } else {
      // Existing parent leases keep working through all tool rounds. New jobs wait.
      while (this.modelTransition) {
        if (priority === 'background') throw new Error('resource_background_unavailable')
        await waitForChange(signal)
      }
      const isForeground = priority === 'foreground'
      if (isForeground) this.foregroundPending += 1
      let foreground: { release(): void } | undefined
      try {
        if (isForeground) {
          const background = this.preemptibleBackground
          background?.controller.abort(new Error('resource_background_preempted'))
          // Wait for inference AND its native lease cleanup before admitting the user.
          if (background) await background.drained
          signal?.throwIfAborted()
          foreground = await this.foregroundAdmission?.(signal)
        }
        let work: LocalResourceWork
        const leaseId = crypto.randomUUID()
        const native = this.dependencies.enabled()
        if (!native) work = { leaseId, resourceRevision: 0 }
        else {
          for (;;) {
            signal?.throwIfAborted()
            try {
              work = await this.dependencies.begin(leaseId)
              break
            } catch (error) {
              if (!pendingError(error)) throw error
              // Background maintenance must never prepare/apply a runtime or wait behind a resource change.
              if (priority === 'background') throw new Error('resource_background_unavailable')
              await this.flush()
              await waitForChange(signal)
            }
          }
        }
        lease = { work: Object.freeze(work), references: 1, native, releaseForeground: foreground?.release }
        this.leases.set(leaseId, lease)
      } catch (error) {
        foreground?.release()
        throw error
      } finally {
        if (isForeground) this.foregroundPending -= 1
      }
    }
    let released = false
    let releasing: Promise<void> | undefined
    const release = async () => {
      if (releasing) return releasing
      if (released) return
      if (lease.references > 1) {
        lease.references -= 1
        released = true
        return
      }
      lease.closing = true
      released = true
      releasing = this.closeLease(lease)
      try {
        await releasing
      } finally {
        releasing = undefined
      }
    }
    if (signal?.aborted) {
      await release()
      signal.throwIfAborted()
    }
    return { work: lease.work, release }
  }

  async run<T>(
    operation: (work: LocalResourceWork) => Promise<T>,
    signal?: AbortSignal,
    parent?: LocalResourceWork,
    group?: string
  ): Promise<T> {
    const lease = await this.acquire(signal, parent)
    if (group) this.groups.set(group, lease.work)
    try {
      return await operation(lease.work)
    } finally {
      if (group && this.groups.get(group) === lease.work) this.groups.delete(group)
      await lease.release()
    }
  }

  /** Trusted idle scheduler only; never exposed to tools or persisted configuration. */
  async runBackground<T>(operation: (work: LocalResourceWork) => Promise<T>, signal: AbortSignal): Promise<T> {
    const lease = await this.acquire(signal, undefined, 'background')
    try {
      signal.throwIfAborted()
      return await operation(lease.work)
    } finally {
      await lease.release()
    }
  }

  /** Bounded resident-only maintenance. Foreground acquisition aborts and drains this owner first. */
  async runPreemptibleBackground<T>(
    operation: (work: LocalResourceWork, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    signal.throwIfAborted()
    if (this.hasWork() || this.isModelSwitchPending()) throw new Error('resource_background_unavailable')
    const controller = new AbortController()
    const background = { controller, drained: Promise.resolve() }
    this.preemptibleBackground = background
    const combined = AbortSignal.any([signal, controller.signal])
    // Registration is synchronous, so a foreground request cannot slip past the drain barrier.
    const result = Promise.resolve().then(() => this.runBackground(work => operation(work, combined), combined))
    background.drained = result.then(
      () => undefined,
      () => undefined
    )
    try {
      return await result
    } finally {
      if (this.preemptibleBackground === background) this.preemptibleBackground = undefined
    }
  }
}

let appliedHandler: ((state: LocalResourceConfigState) => void | Promise<void>) | undefined
export function onLocalResourcesApplied(handler: (state: LocalResourceConfigState) => void | Promise<void>): void {
  appliedHandler = handler
}

export const localResources = new LocalResourceController({
  enabled: () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  get: () => invoke('local_model_get_resource_config'),
  set: (config, expectedRevision) => invoke('local_model_set_resource_config', { config, expectedRevision }),
  apply: expectedRevision => invoke('local_model_apply_resource_config', { expectedRevision }),
  begin: leaseId => invoke('local_model_begin_resource_work', { leaseId }),
  end: leaseId => invoke('local_model_end_resource_work', { leaseId }),
  applied: state => appliedHandler?.(state),
})

export const getLocalResourceConfig = () => localResources.refresh()
export const setLocalResourceConfig = (config: LocalResourceConfig, expectedRevision: number) =>
  localResources.set(config, expectedRevision)
export const subscribeLocalResourceConfig = (listener: (state: LocalResourceConfigState) => void) =>
  localResources.subscribe(listener)
let hardwareSnapshotFlight: Promise<HardwareSnapshot> | undefined
export async function getLocalResourceHardware(): Promise<HardwareSnapshot> {
  // Share simultaneous driver scans; completed hardware data is never cached here.
  const pending = (hardwareSnapshotFlight ??= invoke<HardwareSnapshot>('local_model_hardware_snapshot'))
  try {
    return structuredClone(await pending)
  } finally {
    if (hardwareSnapshotFlight === pending) hardwareSnapshotFlight = undefined
  }
}
