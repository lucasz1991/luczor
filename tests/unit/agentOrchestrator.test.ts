import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentOrchestrator } from '@/services/agents/orchestrator'
import type {
  AgentAdapter,
  AgentJobInput,
  AgentJobMetadata,
  AgentOrchestratorOptions,
  AgentProjectSnapshot,
  AgentRunRequest,
  AgentRunResult,
} from '@/services/agents/types'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

const PROJECT: AgentProjectSnapshot = {
  principalId: 'account-1',
  projectId: 'project-1',
  projectName: 'Private project',
  rootPath: 'E:\\private\\repo',
  workspaceUpdatedAt: 20,
}

function harness(options: Partial<AgentOrchestratorOptions> = {}) {
  let nextId = 0
  let timestamp = 10
  const runs: { request: AgentRunRequest; result: ReturnType<typeof deferred<AgentRunResult>> }[] = []
  const run = vi.fn((request: AgentRunRequest) => {
    const result = deferred<AgentRunResult>()
    runs.push({ request, result })
    return result.promise
  })
  const adapter: AgentAdapter = { id: 'codex', permissions: ['read-only', 'workspace-write'], run }
  const metadata: AgentJobMetadata[] = []
  const validateScope = vi.fn().mockResolvedValue(undefined)
  const orchestrator = new AgentOrchestrator({
    adapters: [adapter],
    validateScope,
    createId: () => `job-${++nextId}`,
    now: () => ++timestamp,
    onMetadata: value => metadata.push(value),
    ...options,
  })
  const enqueue = (overrides: Partial<AgentJobInput> = {}) =>
    orchestrator.enqueue({
      project: PROJECT,
      adapterId: 'codex',
      prompt: 'Private instructions',
      permission: 'read-only',
      ...overrides,
    })
  return { orchestrator, enqueue, runs, run, metadata, validateScope }
}

afterEach(() => vi.useRealTimers())

describe('project agent orchestrator', () => {
  it('keeps a hung adapter locked until a current native-stop proof and rejects its late output', async () => {
    vi.useFakeTimers()
    const { orchestrator, enqueue, runs } = harness({ maxConcurrent: 1 })
    const old = enqueue()
    orchestrator.approve(old.id)
    await flush()
    const generation = orchestrator.requestStopAll()
    expect(runs[0]!.request.signal.aborted).toBe(true)
    expect(() => enqueue()).toThrow('gestoppt')
    const waiting = orchestrator.waitForStop(20)
    await vi.advanceTimersByTimeAsync(20)
    expect(await waiting).toEqual({ settled: false, pendingIds: [old.id] })
    expect(orchestrator.isSettled(old.id)).toBe(false)
    expect(orchestrator.resumeAfterStop()).toBe(false)
    expect(orchestrator.recoverStopped({ generation: generation - 1, nativeStopped: true })).toBe(0)
    expect(orchestrator.recoverStopped({ generation, nativeStopped: true })).toBe(1)
    expect(orchestrator.resumeAfterStop()).toBe(true)
    const fresh = enqueue()
    orchestrator.approve(fresh.id)
    await flush()
    runs[0]!.request.onOutput('Late old output')
    runs[0]!.result.resolve({ output: 'Late completion' })
    await flush()
    expect(orchestrator.getJob(old.id)?.status).toBe('cancelled')
    expect(orchestrator.getOutput(old.id)).toBe('')
    expect(orchestrator.getJob(fresh.id)?.status).toBe('running')
    runs[1]!.result.resolve({ output: 'Fresh result' })
    await flush()
    orchestrator.dispose()
  })

  it('bounds permanent shutdown even when the adapter never acknowledges its aborted signal', async () => {
    vi.useFakeTimers()
    const { orchestrator, enqueue } = harness()
    const job = enqueue()
    orchestrator.approve(job.id)
    await flush()
    const shutdown = orchestrator.shutdown(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(await shutdown).toEqual({ settled: false, pendingIds: [job.id] })
    expect(orchestrator.resumeAfterStop()).toBe(false)
    orchestrator.dispose()
  })
  it('does not finish graceful shutdown until the native adapter acknowledges cancellation', async () => {
    const { orchestrator, enqueue, runs } = harness()
    const job = enqueue()
    orchestrator.approve(job.id)
    await flush()
    let stopped = false
    const shutdown = orchestrator.shutdown().then(() => {
      stopped = true
    })
    expect(runs[0]!.request.signal.aborted).toBe(true)
    expect(() => enqueue()).toThrow('geschlossen')
    await flush()
    expect(stopped).toBe(false)
    runs[0]!.result.resolve({ output: 'Cancelled' })
    await shutdown
    expect(orchestrator.isSettled(job.id)).toBe(true)
  })
  it('freezes workcopy scope privately and still validates the canonical workspace on both sides of execution', async () => {
    const { orchestrator, enqueue, runs, metadata, validateScope } = harness()
    const workflowScope = {
      principalId: PROJECT.principalId,
      projectId: PROJECT.projectId,
      runId: '11111111-1111-4111-8111-111111111111',
      expectedRootPath: 'E:/private-workcopy',
      expectedWorkspaceUpdatedAt: PROJECT.workspaceUpdatedAt!,
    }
    const job = enqueue({ workflowScope })
    workflowScope.expectedRootPath = 'E:/mutated-after-enqueue'
    orchestrator.approve(job.id)
    await flush()
    expect(runs[0]!.request.workflowScope?.expectedRootPath).toBe('E:/private-workcopy')
    expect(Object.isFrozen(runs[0]!.request.workflowScope)).toBe(true)
    expect(runs[0]!.request.project.rootPath).toBe(PROJECT.rootPath)
    runs[0]!.result.resolve({ output: 'Reviewed' })
    await flush()
    expect(validateScope).toHaveBeenCalledTimes(2)
    expect(validateScope).toHaveBeenLastCalledWith(PROJECT, 'read-only')
    expect(JSON.stringify(metadata)).not.toContain('private-workcopy')
    expect(JSON.stringify(orchestrator.getJob(job.id))).not.toContain('private-workcopy')
    expect(() => enqueue({ workflowScope, externalThreadId: 'old-thread' })).toThrow('Agentensitzung')
  })
  it('retains only allowlisted actual worker metadata across the job lifecycle', async () => {
    const { orchestrator, enqueue, runs } = harness()
    const job = enqueue({ model: 'requested-model' })
    orchestrator.approve(job.id)
    await flush()
    runs[0]!.result.resolve({
      output: 'Done',
      runtimeEvidence: { model: 'actual-model', modelSource: 'runtime', toolGateChecks: 2 },
    })
    await flush()
    expect(orchestrator.getJob(job.id)).toMatchObject({
      model: 'requested-model',
      runtimeEvidence: { model: 'actual-model', modelSource: 'runtime', toolGateChecks: 2 },
    })
  })

  it('rejects runtime claims with missing provenance or invalid gate counts', async () => {
    const { orchestrator, enqueue, runs } = harness()
    const job = enqueue()
    orchestrator.approve(job.id)
    await flush()
    runs[0]!.result.resolve({ output: 'Done', runtimeEvidence: { model: 'unconfirmed', toolGateChecks: -1 } })
    await flush()
    expect(orchestrator.getJob(job.id)).toMatchObject({ status: 'failed', errorCode: 'invalid_result' })
    expect(orchestrator.getJob(job.id)?.runtimeEvidence).toBeUndefined()
  })

  it('requires approval for every backend and preserves the immutable account and workspace snapshot', async () => {
    const { orchestrator, enqueue, runs, run, validateScope } = harness()
    const project = { ...PROJECT }
    const job = enqueue({ project, permission: 'workspace-write' })
    project.principalId = 'attacker'
    project.rootPath = 'E:\\other'
    await flush()

    expect(job.status).toBe('awaiting_approval')
    expect(run).not.toHaveBeenCalled()
    expect(Object.isFrozen(job)).toBe(true)
    expect(Object.isFrozen(job.project)).toBe(true)
    expect(orchestrator.getPrompt(job.id)).toBe('Private instructions')
    expect(orchestrator.approve(job.id)).toBe(true)
    expect(orchestrator.approve(job.id)).toBe(false)
    await flush()

    expect(validateScope).toHaveBeenCalledWith(PROJECT, 'workspace-write')
    expect(runs[0]!.request.project).toEqual(PROJECT)
    expect(orchestrator.getJob(job.id)?.status).toBe('running')
    runs[0]!.result.resolve({ output: 'A result', externalThreadId: 'real-runtime-id' })
    await flush()
    expect(orchestrator.getJob(job.id)).toMatchObject({ status: 'completed', externalThreadId: 'real-runtime-id' })
    expect(orchestrator.getOutput(job.id)).toBe('A result')
    expect(orchestrator.getPrompt(job.id)).toBe('')
    expect(validateScope).toHaveBeenCalledTimes(2)
  })

  it('never starts an adapter when the approved scope or execution policy changed', async () => {
    const { orchestrator, enqueue, validateScope, run } = harness()
    validateScope.mockRejectedValue(new Error('private token or path must not be archived'))
    const job = enqueue()
    orchestrator.approve(job.id)
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(orchestrator.getJob(job.id)).toMatchObject({ status: 'failed', errorCode: 'scope_changed' })
    expect(orchestrator.getOutput(job.id)).toBe('')
  })

  it('serializes workspace writes while fairly serving work on other projects', async () => {
    const { orchestrator, enqueue, runs } = harness({ maxConcurrent: 2 })
    const first = enqueue()
    const second = enqueue({ permission: 'workspace-write' })
    const third = enqueue({ project: { ...PROJECT, projectId: 'project-2', rootPath: 'E:\\repo-2' } })
    const fourth = enqueue({ project: { ...PROJECT, projectId: 'project-3', rootPath: 'E:\\repo-3' } })
    for (const job of [first, second, third, fourth]) orchestrator.approve(job.id)
    await flush()
    expect(runs.map(run => run.request.jobId)).toEqual([first.id, third.id])
    expect(orchestrator.getJob(second.id)?.status).toBe('queued')
    expect(orchestrator.getJob(fourth.id)?.status).toBe('queued')
    runs[0]!.result.resolve({ output: 'done' })
    await flush()
    expect(runs.map(run => run.request.jobId)).toEqual([first.id, third.id, fourth.id])
    runs[1]!.result.resolve({ output: 'done' })
    await flush()
    expect(runs.map(run => run.request.jobId)).toEqual([first.id, third.id, fourth.id, second.id])
  })

  it('allows two read-only jobs in one workspace to run concurrently', async () => {
    const { orchestrator, enqueue, runs } = harness({ maxConcurrent: 2 })
    const first = enqueue()
    const second = enqueue()
    orchestrator.approve(first.id)
    orchestrator.approve(second.id)
    await flush()
    expect(runs.map(run => run.request.jobId)).toEqual([first.id, second.id])
    orchestrator.cancel(first.id)
    orchestrator.cancel(second.id)
    runs.forEach(run => run.result.resolve({ output: 'late' }))
  })

  it('expires an unapproved prompt without dispatching or retaining it', async () => {
    vi.useFakeTimers()
    const { orchestrator, enqueue, run } = harness({ approvalTimeoutMs: 1_000 })
    const job = enqueue()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(orchestrator.getJob(job.id)).toMatchObject({ status: 'cancelled', errorCode: 'approval_expired' })
    expect(orchestrator.getPrompt(job.id)).toBe('')
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps the canonical workspace locked across accounts until cancelled execution actually stops', async () => {
    const { orchestrator, enqueue, runs, metadata } = harness()
    const first = enqueue({ permission: 'workspace-write' })
    const second = enqueue({
      project: { ...PROJECT, principalId: 'account-2', projectId: 'project-2', rootPath: 'e:/PRIVATE/repo' },
    })
    orchestrator.approve(first.id)
    orchestrator.approve(second.id)
    await flush()
    expect(runs).toHaveLength(1)
    expect(orchestrator.cancel(first.id)).toBe(true)
    expect(runs[0]!.request.signal.aborted).toBe(true)
    runs[0]!.request.onOutput('late output')
    await flush()
    expect(runs).toHaveLength(1)
    runs[0]!.result.resolve({ output: 'late result', externalThreadId: 'must-not-link' })
    await flush()
    expect(orchestrator.getOutput(first.id)).toBe('')
    expect(orchestrator.getJob(first.id)?.status).toBe('cancelled')
    expect(metadata.some(record => record.externalThreadId === 'must-not-link')).toBe(false)
    expect(runs).toHaveLength(2)
  })

  it('cancels queued work and also suppresses starts while scope validation is pending', async () => {
    const gate = deferred<void>()
    const { orchestrator, enqueue, run } = harness({ validateScope: () => gate.promise })
    const job = enqueue()
    orchestrator.approve(job.id)
    await flush()
    expect(orchestrator.cancel(job.id)).toBe(true)
    gate.resolve()
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(orchestrator.getJob(job.id)?.status).toBe('cancelled')
    expect(orchestrator.cancel(job.id)).toBe(false)
  })

  it('honors cancellation raised by a synchronous UI subscriber before adapter dispatch', async () => {
    const { orchestrator, enqueue, run } = harness()
    const job = enqueue()
    orchestrator.subscribe(() => {
      if (orchestrator.getJob(job.id)?.status === 'running') orchestrator.cancel(job.id)
    })
    orchestrator.approve(job.id)
    await flush()
    expect(run).not.toHaveBeenCalled()
  })

  it('bounds output snapshots, keeps sensitive content out of metadata and validates returned thread IDs', async () => {
    const { orchestrator, enqueue, runs, metadata } = harness({ maxOutputCharacters: 10 })
    const job = enqueue()
    orchestrator.approve(job.id)
    await flush()
    runs[0]!.request.onOutput('first')
    runs[0]!.request.onOutput('replacement text')
    expect(orchestrator.getOutput(job.id)).toBe('replacemen')
    runs[0]!.result.resolve({ output: 'private output', externalThreadId: 'bad\nid' })
    await flush()
    expect(orchestrator.getJob(job.id)).toMatchObject({ status: 'failed', errorCode: 'invalid_result' })
    const archive = JSON.stringify(metadata)
    for (const secret of ['Private instructions', PROJECT.rootPath!, PROJECT.projectName, 'private output', 'bad']) {
      expect(archive).not.toContain(secret)
    }
    expect(metadata.every(Object.isFrozen)).toBe(true)
  })

  it('discards output and returned thread identity when the account changes before completion', async () => {
    const { orchestrator, enqueue, runs, validateScope } = harness()
    const job = enqueue()
    orchestrator.approve(job.id)
    await flush()
    runs[0]!.request.onOutput('private result')
    validateScope.mockRejectedValue(new Error('changed'))
    runs[0]!.result.resolve({ output: 'final', externalThreadId: 'external-id' })
    await flush()
    expect(orchestrator.getOutput(job.id)).toBe('')
    expect(orchestrator.getJob(job.id)).toMatchObject({ status: 'failed', errorCode: 'scope_changed' })
    expect(orchestrator.getJob(job.id)?.externalThreadId).toBeUndefined()
  })

  it('isolates project listings and clears live account content without releasing the active worker lock', async () => {
    const { orchestrator, enqueue, runs } = harness()
    const active = enqueue()
    const waiting = enqueue({ permission: 'workspace-write' })
    const other = enqueue({ project: { ...PROJECT, principalId: 'account-2' } })
    orchestrator.approve(active.id)
    await flush()
    runs[0]!.request.onOutput('private content')
    orchestrator.clearPrincipal('account-1')
    expect(orchestrator.getOutput(active.id)).toBe('')
    expect(orchestrator.getPrompt(active.id)).toBe('')
    expect(orchestrator.getJob(waiting.id)).toBeUndefined()
    expect(orchestrator.listJobs('account-2').map(job => job.id)).toEqual([other.id])
    runs[0]!.result.resolve({ output: 'late' })
    await flush()
    expect(orchestrator.listJobs('account-1')).toEqual([])
  })

  it('bounds waiting jobs per project and globally, plus finished history', async () => {
    const { orchestrator, enqueue, runs } = harness({ maxPendingPerProject: 1, maxPendingTotal: 2, maxHistory: 1 })
    const first = enqueue()
    expect(() => enqueue()).toThrow('für dieses Projekt ist voll')
    const second = enqueue({ project: { ...PROJECT, projectId: 'project-2' } })
    expect(() => enqueue({ project: { ...PROJECT, projectId: 'project-3' } })).toThrow('warteschlange ist voll')
    orchestrator.approve(first.id)
    await flush()
    runs[0]!.result.resolve({ output: 'first private result' })
    await flush()
    orchestrator.cancel(second.id)
    expect(orchestrator.getJob(first.id)).toBeUndefined()
    expect(orchestrator.getOutput(first.id)).toBe('')
    expect(orchestrator.getJob(second.id)?.status).toBe('cancelled')
  })

  it('rejects unavailable capabilities, unsafe inputs and write access without a workspace', () => {
    const local: AgentAdapter = { id: 'local', permissions: ['read-only'], run: vi.fn() }
    const { enqueue } = harness({ adapters: [local], maxPromptCharacters: 20 })
    expect(() => enqueue()).toThrow('nicht verfügbar')
    expect(() => enqueue({ adapterId: 'local', permission: 'workspace-write' })).toThrow('Freigabe nicht')
    expect(() => enqueue({ adapterId: 'local', prompt: ' '.repeat(3) })).toThrow('Zeichen')
    expect(() => enqueue({ adapterId: 'local', prompt: 'x'.repeat(21) })).toThrow('Zeichen')
    expect(() => enqueue({ adapterId: 'local', project: { ...PROJECT, principalId: '' } })).toThrow('Projektzuordnung')
    expect(() => enqueue({ adapterId: 'local', externalThreadId: 'x\ny' })).toThrow('Aufgaben-ID')
    const normal = harness()
    expect(() =>
      normal.enqueue({ permission: 'workspace-write', project: { ...PROJECT, rootPath: undefined } })
    ).toThrow('Ordner')
  })

  it('records safe failure metadata and does not allow faulty history listeners to strand later jobs', async () => {
    const { orchestrator, enqueue, runs } = harness({
      onMetadata: () => {
        throw new Error('disk failure')
      },
    })
    orchestrator.subscribe(() => {
      throw new Error('render failure')
    })
    const first = enqueue()
    const second = enqueue({ permission: 'workspace-write' })
    orchestrator.approve(first.id)
    orchestrator.approve(second.id)
    await flush()
    runs[0]!.result.reject(new Error('provider secret'))
    await flush()
    expect(orchestrator.getJob(first.id)).toMatchObject({ status: 'failed', errorCode: 'execution_failed' })
    expect(JSON.stringify(orchestrator.getJob(first.id))).not.toContain('provider secret')
    expect(runs).toHaveLength(2)
  })

  it('disposes queued and running work without accepting late results or new jobs', async () => {
    const { orchestrator, enqueue, runs } = harness()
    const first = enqueue()
    const second = enqueue({ permission: 'workspace-write' })
    orchestrator.approve(first.id)
    orchestrator.approve(second.id)
    await flush()
    orchestrator.dispose()
    runs[0]!.result.resolve({ output: 'late', externalThreadId: 'late-id' })
    await flush()
    expect(runs).toHaveLength(1)
    expect(orchestrator.getJob(first.id)?.status).toBe('cancelled')
    expect(orchestrator.getJob(second.id)?.status).toBe('cancelled')
    expect(orchestrator.getOutput(first.id)).toBe('')
    expect(() => enqueue()).toThrow('geschlossen')
  })
})
