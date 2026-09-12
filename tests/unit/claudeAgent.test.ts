import { describe, expect, it, vi } from 'vitest'
import {
  createClaudeAgentAdapter,
  type ClaudeAgentDependencies,
  type ClaudeJobSnapshot,
} from '@/services/agents/claudeAgent'
import type { AgentRunRequest } from '@/services/agents/types'

function snapshot(status: string, output = ''): ClaudeJobSnapshot {
  return {
    id: 'native-job',
    principalId: 'p',
    projectId: 'project',
    status,
    output,
    outputTruncated: false,
    toolCalls: 0,
  }
}
function request(controller = new AbortController()): AgentRunRequest {
  return {
    jobId: 'job',
    project: {
      principalId: 'p',
      projectId: 'project',
      projectName: 'Project',
      rootPath: 'E:\\project',
      workspaceUpdatedAt: 2,
    },
    prompt: 'Review the project',
    permission: 'read-only',
    role: 'reviewer',
    executionProfile: 'host-user',
    signal: controller.signal,
    onOutput: vi.fn(),
  }
}
function harness() {
  const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>()
  const externalPolicy = vi.fn<ClaudeAgentDependencies['externalPolicy']>().mockResolvedValue('ask')
  const wait = vi.fn(async () => undefined)
  const dependencies: ClaudeAgentDependencies = {
    invoke: invoke as ClaudeAgentDependencies['invoke'],
    externalPolicy,
    wait,
    captureExecution: signal => ({ signal, authorize: async () => ({ sessionId: 'session', generation: 3 }) }),
  }
  return { invoke, externalPolicy, wait, dependencies }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { resolve, promise }
}

describe('managed Claude adapter', () => {
  it('sends a run-bound workcopy to native validation instead of overwriting the canonical binding', async () => {
    const fixture = harness()
    fixture.invoke.mockResolvedValueOnce(snapshot('completed', 'Done'))
    const original = request()
    const workflowScope = {
      principalId: original.project.principalId,
      projectId: original.project.projectId,
      runId: '11111111-1111-4111-8111-111111111111',
      expectedRootPath: 'E:/workcopy',
      expectedWorkspaceUpdatedAt: original.project.workspaceUpdatedAt!,
    }
    await createClaudeAgentAdapter(fixture.dependencies).run({ ...original, workflowScope })
    expect(fixture.invoke).toHaveBeenCalledWith('claude_job_start', {
      payload: expect.objectContaining({ expectedRootPath: 'E:/workcopy', workflowScope }),
    })
    expect(original.project.rootPath).toBe('E:\\project')
  })
  it('keeps reviewed scope and budgets and confirms effort only from measured hook metadata', async () => {
    const fixture = harness()
    fixture.invoke
      .mockResolvedValueOnce(snapshot('running'))
      .mockResolvedValueOnce({ ...snapshot('completed', 'Checked'), model: 'claude-opus-4-7', appliedEffort: 'high' })
    const result = await createClaudeAgentAdapter(fixture.dependencies).run({
      ...request(),
      thinkingTier: 'fast',
      model: 'claude-opus-4-7',
      defaultModelRevision: 'b'.repeat(64),
      maxBudgetUsd: 2,
      maxTurns: 8,
    })
    expect(fixture.invoke).toHaveBeenNthCalledWith(1, 'claude_job_start', {
      payload: expect.objectContaining({
        expectedWorkspaceUpdatedAt: 2,
        model: 'claude-opus-4-7',
        defaultModelRevision: 'b'.repeat(64),
        effort: 'high',
        maxTurns: 8,
        maxBudgetUsd: 2,
        execution: { sessionId: 'session', generation: 3 },
        executionProfile: 'host-user',
        hostAccessAcknowledged: true,
      }),
    })
    expect(result.effortSelection).toMatchObject({
      status: 'confirmed',
      requestedEffort: 'high',
      appliedEffort: 'high',
    })
    expect(result.runtimeEvidence).toEqual({ model: 'claude-opus-4-7', modelSource: 'runtime', toolGateChecks: 0 })
  })
  it('does not claim default-model effort or runtime readiness from installation', async () => {
    const fixture = harness()
    fixture.invoke.mockResolvedValueOnce(snapshot('completed', 'Done'))
    const result = await createClaudeAgentAdapter(fixture.dependencies).run(request())
    expect(result.effortSelection).toMatchObject({ status: 'unknown', reason: 'default_model_unresolved' })
    expect(result.effortSelection?.appliedEffort).toBeUndefined()
    expect(result.runtimeEvidence?.model).toBeUndefined()
    expect(result.runtimeEvidence?.modelSource).toBeUndefined()
  })
  it('waits for actual stop after cancellation during start and suppresses late output', async () => {
    const fixture = harness()
    const controller = new AbortController()
    const starting = deferred<ClaudeJobSnapshot>()
    const stopped = deferred<ClaudeJobSnapshot>()
    const entered = deferred<void>()
    fixture.invoke.mockImplementation(async command => {
      if (command === 'claude_job_start') {
        entered.resolve()
        return starting.promise
      }
      if (command === 'claude_job_cancel') return snapshot('cancelling')
      return stopped.promise
    })
    const input = request(controller)
    const run = createClaudeAgentAdapter(fixture.dependencies).run(input)
    await entered.promise
    controller.abort()
    starting.resolve(snapshot('running', 'Late text'))
    let settled = false
    const observed = run.finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(fixture.invoke).toHaveBeenCalledWith('claude_job_cancel', expect.anything()))
    expect(settled).toBe(false)
    stopped.resolve(snapshot('cancelled', 'Later text'))
    await expect(observed).rejects.toMatchObject({ name: 'AbortError' })
    expect(input.onOutput).not.toHaveBeenCalled()
  })
  it('cancels and waits when the output observer fails', async () => {
    const fixture = harness()
    fixture.invoke.mockImplementation(async command =>
      command === 'claude_job_start' ? snapshot('running', 'Partial') : snapshot('cancelled')
    )
    await expect(
      createClaudeAgentAdapter(fixture.dependencies).run({
        ...request(),
        onOutput() {
          throw new Error('UI disposed')
        },
      })
    ).rejects.toThrow()
    expect(fixture.invoke).toHaveBeenCalledWith('claude_job_cancel', expect.anything())
  })
  it('rejects denied policy, missing host profile, resume and empty results', async () => {
    const fixture = harness()
    const adapter = createClaudeAgentAdapter(fixture.dependencies)
    await expect(adapter.run({ ...request(), executionProfile: 'workspace' })).rejects.toThrow('Benutzerrechte')
    await expect(adapter.run({ ...request(), externalThreadId: 'old-session' })).rejects.toThrow('Sitzungen')
    fixture.externalPolicy.mockResolvedValueOnce('deny')
    await expect(adapter.run(request())).rejects.toThrow('verbietet')
    expect(fixture.invoke).not.toHaveBeenCalled()
    fixture.invoke.mockResolvedValueOnce(snapshot('completed'))
    await expect(adapter.run(request())).rejects.toThrow('verwertbares')
  })
})
