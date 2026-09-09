import { describe, expect, it, vi } from 'vitest'
import {
  createCodexAgentAdapter,
  type CodexAgentDependencies,
  type CodexJobSnapshot,
} from '@/services/agents/codexAgent'
import type { AgentRunRequest } from '@/services/agents/types'

function snapshot(status: CodexJobSnapshot['status'], output = ''): CodexJobSnapshot {
  return {
    id: 'native-job',
    principalId: 'principal',
    projectId: 'project',
    status,
    output,
    createdAt: 1,
    outputTruncated: false,
  }
}

function request(controller = new AbortController()): AgentRunRequest {
  return {
    jobId: 'job',
    project: {
      principalId: 'principal',
      projectId: 'project',
      projectName: 'Project',
      rootPath: 'E:\\project',
      workspaceUpdatedAt: 10,
    },
    permission: 'read-only',
    role: 'assistant',
    prompt: 'Review this project.',
    signal: controller.signal,
    onOutput: vi.fn(),
  }
}

function harness() {
  const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>()
  const externalPolicy = vi.fn<CodexAgentDependencies['externalPolicy']>().mockResolvedValue('ask')
  const wait = vi.fn(async () => undefined)
  const captureExecution: CodexAgentDependencies['captureExecution'] = signal => ({
    signal,
    authorize: vi.fn(async () => ({ sessionId: 'session', generation: 7 })),
  })
  return {
    invoke,
    externalPolicy,
    wait,
    dependencies: { invoke: invoke as CodexAgentDependencies['invoke'], externalPolicy, wait, captureExecution },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { resolve, promise }
}

describe('native Codex agent adapter', () => {
  it('pins the reviewed model and requested effort with the metadata revision, without claiming it was applied', async () => {
    const fixture = harness()
    fixture.invoke
      .mockResolvedValueOnce({
        revision: 'current',
        source: 'codex-cache',
        models: [{ model: 'gpt-6-astra', supportedEfforts: ['low', 'medium', 'high', 'max', 'ultra'] }],
      })
      .mockResolvedValueOnce(snapshot('completed', 'Done'))
    const result = await createCodexAgentAdapter(fixture.dependencies).run({
      ...request(),
      model: 'gpt-6-astra',
      thinkingTier: 'ultra',
    })
    expect(fixture.invoke).toHaveBeenNthCalledWith(2, 'codex_job_start', {
      payload: expect.objectContaining({ model: 'gpt-6-astra', effort: 'ultra', capabilityRevision: 'current' }),
    })
    expect(result.effortSelection).toMatchObject({
      requestedEffort: 'ultra',
      status: 'requested',
      capabilitySource: 'codex-cache',
    })
    expect(result.effortSelection?.appliedEffort).toBeUndefined()
  })

  it('does not start when a node effort override is unsupported for its pinned model', async () => {
    const fixture = harness()
    fixture.invoke.mockResolvedValueOnce({
      revision: 'current',
      models: [{ model: 'older', supportedEfforts: ['low', 'high'] }],
    })
    await expect(
      createCodexAgentAdapter(fixture.dependencies).run({ ...request(), model: 'older', effort: 'ultra' })
    ).rejects.toThrow('unterstützt')
    expect(fixture.invoke).toHaveBeenCalledTimes(1)
  })

  it('polls starting/running states and binds workspace version and explicit resume ID', async () => {
    const fixture = harness()
    fixture.invoke
      .mockResolvedValueOnce(snapshot('starting'))
      .mockResolvedValueOnce(snapshot('running', 'Partial'))
      .mockResolvedValueOnce({
        ...snapshot('completed', 'Done'),
        externalThreadId: '00000000-0000-4000-8000-000000000001',
      })
    const input = { ...request(), externalThreadId: '00000000-0000-4000-8000-000000000002' }
    const result = await createCodexAgentAdapter(fixture.dependencies).run(input)
    expect(result.output).toBe('Done')
    expect(fixture.invoke).toHaveBeenNthCalledWith(1, 'codex_job_start', {
      payload: expect.objectContaining({
        expectedRootPath: input.project.rootPath,
        expectedWorkspaceUpdatedAt: 10,
        externalThreadId: input.externalThreadId,
        permission: 'read-only',
        execution: { sessionId: 'session', generation: 7 },
      }),
    })
    expect(input.onOutput).toHaveBeenCalledWith('Partial')
  })

  it('keeps the slot until cancelling becomes terminal and never publishes late output', async () => {
    const fixture = harness()
    const controller = new AbortController()
    const entered = deferred<void>()
    const stop = deferred<CodexJobSnapshot>()
    fixture.invoke.mockImplementation(async command => {
      if (command === 'codex_job_start') return snapshot('running') as never
      if (command === 'codex_job_cancel') return snapshot('cancelling') as never
      entered.resolve()
      return (await stop.promise) as never
    })
    const input = request(controller)
    const running = createCodexAgentAdapter(fixture.dependencies).run(input)
    let settled = false
    const observed = running.finally(() => {
      settled = true
    })
    await entered.promise
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    stop.resolve(snapshot('cancelled', 'Late text'))
    await expect(observed).rejects.toMatchObject({ name: 'AbortError' })
    expect(input.onOutput).not.toHaveBeenCalledWith('Late text')
    expect(fixture.invoke).toHaveBeenCalledWith('codex_job_cancel', {
      payload: { principalId: 'principal', projectId: 'project', jobId: 'native-job' },
    })
  })

  it('cancels when the user aborts while native start is still pending', async () => {
    const fixture = harness()
    const controller = new AbortController()
    const starting = deferred<CodexJobSnapshot>()
    const entered = deferred<void>()
    fixture.invoke.mockImplementation(async command => {
      if (command === 'codex_job_start') {
        entered.resolve()
        return (await starting.promise) as never
      }
      return snapshot(command === 'codex_job_cancel' ? 'cancelling' : 'cancelled') as never
    })
    const running = createCodexAgentAdapter(fixture.dependencies).run(request(controller))
    await entered.promise
    controller.abort()
    starting.resolve(snapshot('starting'))
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(fixture.invoke).toHaveBeenCalledWith('codex_job_cancel', expect.anything())
  })

  it('cancels after a failed poll and waits for native exit before surfacing a redacted error', async () => {
    const fixture = harness()
    fixture.invoke
      .mockResolvedValueOnce(snapshot('running'))
      .mockRejectedValueOnce(new Error('secret-token'))
      .mockResolvedValueOnce(snapshot('cancelling'))
      .mockResolvedValueOnce(snapshot('cancelled'))
    await expect(createCodexAgentAdapter(fixture.dependencies).run(request())).rejects.toThrow('Laufzeitstatus')
    expect(fixture.invoke).toHaveBeenLastCalledWith('codex_job_status', expect.anything())
    expect(fixture.invoke).toHaveBeenCalledTimes(4)
  })

  it('never includes raw native errors in the caller-facing exception', async () => {
    const fixture = harness()
    fixture.invoke.mockResolvedValue({ ...snapshot('failed'), error: 'Bearer sensitive-key' })
    await expect(createCodexAgentAdapter(fixture.dependencies).run(request())).rejects.toThrow('Laufzeitstatus')
    fixture.invoke.mockRejectedValue(new Error('Bearer sensitive-key'))
    await expect(createCodexAgentAdapter(fixture.dependencies).run(request())).rejects.toThrow('konnte nicht gestartet')
  })

  it('rejects denied egress and missing binding version without starting the worker', async () => {
    const fixture = harness()
    fixture.externalPolicy.mockResolvedValue('deny')
    await expect(createCodexAgentAdapter(fixture.dependencies).run(request())).rejects.toThrow('Repository-Richtlinie')
    fixture.externalPolicy.mockResolvedValue('ask')
    await expect(
      createCodexAgentAdapter(fixture.dependencies).run({
        ...request(),
        project: { ...request().project, workspaceUpdatedAt: undefined },
      })
    ).rejects.toThrow('Projektordner')
    expect(fixture.invoke).not.toHaveBeenCalled()
  })

  it('treats native timeout as terminal and does not poll indefinitely', async () => {
    const fixture = harness()
    fixture.invoke.mockResolvedValue(snapshot('timed_out'))
    await expect(createCodexAgentAdapter(fixture.dependencies).run(request())).rejects.toThrow('Laufzeitstatus')
    expect(fixture.invoke).toHaveBeenCalledTimes(1)
  })

  it('does not abandon native polling when an output observer throws', async () => {
    const fixture = harness()
    fixture.invoke.mockResolvedValueOnce(snapshot('running')).mockResolvedValueOnce(snapshot('completed', 'Done'))
    await expect(
      createCodexAgentAdapter(fixture.dependencies).run({
        ...request(),
        onOutput: () => {
          throw new Error('UI error')
        },
      })
    ).resolves.toMatchObject({ output: 'Done' })
  })
})
