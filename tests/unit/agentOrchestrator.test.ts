import { describe, expect, it, vi } from 'vitest'
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

describe('project agent orchestrator', () => {
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

  it('serializes a project while allowing bounded work on another project', async () => {
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
    expect(runs.map(run => run.request.jobId)).toEqual([first.id, third.id, second.id])
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
    const waiting = enqueue()
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
    const second = enqueue()
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
    const second = enqueue()
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
