import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: vi.fn() }))
vi.mock('@/services/agents/hub', () => ({ agentProjectSnapshot: vi.fn() }))
vi.mock('@/services/agents/workflowAgent', () => ({ runWorkflowAgent: vi.fn() }))
vi.mock('@/services/agent', () => ({ runAgent: vi.fn() }))
import { runWorkflowAgentFlow } from '@/services/workflows/agentFlow'
import type { RunAgentOptions, RunAgentResult } from '@/services/agent'

function fixture(overrides: Partial<RunAgentResult> = {}) {
  const controller = new AbortController()
  const account = {
    principalId: 'principal',
    serverOrigin: 'https://example.test',
    serverInstance: 'server',
    accountId: 1,
    config: { baseUrl: 'https://example.test', clientId: 'device', deviceKey: 'synthetic-test-key' },
  }
  const project = {
    principalId: 'principal',
    projectId: 'project',
    projectName: 'Test',
    rootPath: 'C:/fixture',
    workspaceUpdatedAt: 1,
  }
  const answer: RunAgentResult = {
    finalText: 'Ergebnis',
    toolFailures: 0,
    toolSuccesses: 1,
    ephemeralDataUsed: false,
    inferenceTarget: 'local_llama_cpp',
    model: 'signed-model',
    tokenUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, rounds: 1, source: 'reported' },
    ...overrides,
  }
  const deps = {
    account: vi.fn(async () => account),
    project: vi.fn(async () => project),
    run: vi.fn<(options: RunAgentOptions) => Promise<RunAgentResult>>(async () => answer),
    managed: vi.fn(async () => ({ ok: true, code: 0, stdout: 'CLI result', stderr: '' })),
    assert: vi.fn((ticket: { signal: AbortSignal }) => ticket.signal.throwIfAborted()),
    mode: () => 'act' as const,
    confirm: vi.fn(async () => ({ approved: true })),
    approve: vi.fn(async () => true),
  }
  return {
    deps,
    account,
    project,
    answer,
    controller,
    context: {
      projectId: 'project',
      thinkingTier: 'thorough' as const,
      ticket: { sessionId: 'session', generation: 1, signal: controller.signal },
    },
  }
}

afterEach(() => vi.useRealTimers())

describe('workflow agent adapter', () => {
  it('uses the local scoped agent and preserves measured model/usage and inherited thinking', async () => {
    const { deps, context } = fixture()
    const result = await runWorkflowAgentFlow(
      false,
      { instruction: 'Analyse', input_bindings: { value: 3 } },
      context,
      deps
    )
    expect(result).toMatchObject({
      ok: true,
      outcome: 'success',
      model: 'signed-model',
      thinking_tier: 'thorough',
      tokens: { totalTokens: 7 },
    })
    expect(deps.run).toHaveBeenCalledOnce()
    expect(deps.run.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'project',
      principalScopeId: 'principal',
      agentMode: false,
      contextEgress: 'local_only',
      thinkingTier: 'thorough',
      taskCreateRecoveryReady: false,
    })
    expect(deps.run.mock.calls[0]?.[0].disabledTools).toEqual(
      expect.arrayContaining([
        'workflow_create',
        'workflow_update',
        'workflow_run_start',
        'workflow_run_cancel',
        'workflow_trigger_save',
        'workflow_trigger_delete',
        'workflow_automation_configure',
      ])
    )
    expect(deps.managed).not.toHaveBeenCalled()
    expect(deps.approve).not.toHaveBeenCalled()
  })

  it('starts a real chat team using separately approved admin specialist packets', async () => {
    const { deps, context, answer } = fixture()
    deps.run.mockImplementationOnce(async options => {
      expect(options.agentMode).toBe(true)
      expect(options.agentTeamPreset).toBe('budget')
      const approval = await options.requestAgentTeamApproval!({
        destination: 'https://example.test/api/v1/proxy/chat',
        packetHash: 'a'.repeat(64),
        policyRevision: 'b'.repeat(64),
        preset: 'budget',
        packets: [],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        toolsAllowed: false,
      })
      expect(approval).toBe(true)
      return answer
    })
    const result = await runWorkflowAgentFlow(true, { instruction: 'Bearbeiten', team_preset: 'budget' }, context, deps)
    expect(result.selection_reason).toBe('local_orchestrator_with_approved_admin_specialists')
    expect(deps.approve).toHaveBeenCalledOnce()
  })

  it('routes a manual model and tier to the managed adapter without claiming confirmed application', async () => {
    const { deps, context } = fixture()
    const result = await runWorkflowAgentFlow(
      false,
      {
        instruction: 'Code prüfen',
        agent_selection: 'override',
        agent: 'codex',
        model: 'user-chosen-model',
        thinking_tier: 'ultra',
      },
      context,
      deps
    )
    expect(deps.managed).toHaveBeenCalledWith(
      'codex',
      expect.any(String),
      'C:/fixture',
      expect.any(AbortSignal),
      'project',
      { thinkingTier: 'ultra', model: 'user-chosen-model' }
    )
    expect(result).toMatchObject({
      ok: true,
      requested_model: 'user-chosen-model',
      model: null,
      thinking_tier: 'ultra',
      thinking_application: 'adapter_not_confirmed',
    })
    expect(deps.run).not.toHaveBeenCalled()
  })

  it.each([
    [{ interrupted: { code: 'readiness_unavailable', message: 'Unavailable', round: 1 } }, 'partial'],
    [{ finalText: '' }, 'failed'],
    [
      {
        specialistOutcomes: [
          {
            role: 'review',
            output: 'partial',
            durationMs: 1,
            incomplete: true,
            tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, rounds: 1, source: 'reported' },
          },
        ],
      },
      'partial',
    ],
  ] as const)('never marks an incomplete result successful', async (changes, outcome) => {
    const { deps, context } = fixture(changes as Partial<RunAgentResult>)
    expect(await runWorkflowAgentFlow(true, { instruction: 'Bearbeiten' }, context, deps)).toMatchObject({
      ok: false,
      outcome,
    })
    expect(deps.run).toHaveBeenCalledOnce()
  })

  it('keeps ephemeral output off the server when its separate export is denied', async () => {
    const { deps, context } = fixture({ finalText: 'Sensitive local result', ephemeralDataUsed: true })
    deps.approve.mockResolvedValueOnce(false)
    expect(await runWorkflowAgentFlow(false, { instruction: 'Analyse' }, context, deps)).toEqual({
      ok: false,
      code: 'workflow_agent_result_export_denied',
    })
    expect(deps.approve).toHaveBeenCalledOnce()
  })

  it('forwards supported Claude limits and refuses unimplemented Codex cost controls', async () => {
    const { deps, context } = fixture()
    await runWorkflowAgentFlow(
      false,
      { instruction: 'Work', agent_selection: 'override', agent: 'claude', max_turns: 8, max_budget_usd: 0.25 },
      context,
      deps
    )
    expect(deps.managed).toHaveBeenCalledWith(
      'claude',
      expect.any(String),
      'C:/fixture',
      expect.any(AbortSignal),
      'project',
      expect.objectContaining({ maxTurns: 8, maxBudgetUsd: 0.25 })
    )
    await expect(
      runWorkflowAgentFlow(
        false,
        { instruction: 'Work', agent_selection: 'override', agent: 'codex', max_budget_usd: 0.25 },
        context,
        deps
      )
    ).rejects.toThrow('workflow_codex_budget_controls_unavailable')
    expect(deps.managed).toHaveBeenCalledOnce()
  })

  it('rejects a changed workspace after execution and never exports that late result', async () => {
    const { deps, context, answer, project } = fixture({ ephemeralDataUsed: true })
    deps.run.mockImplementationOnce(async () => {
      deps.project.mockResolvedValue({ ...project, workspaceUpdatedAt: 2 })
      return answer
    })
    await expect(runWorkflowAgentFlow(false, { instruction: 'Analyse' }, context, deps)).rejects.toThrow(
      'scope_changed'
    )
    expect(deps.approve).not.toHaveBeenCalled()
  })

  it('keeps individual tool approvals and discards a late approval after revocation', async () => {
    const { deps, context, controller, answer } = fixture()
    deps.confirm.mockImplementationOnce(async () => {
      controller.abort()
      return { approved: true }
    })
    deps.run.mockImplementationOnce(async options => {
      options.toolSession!.queue({
        id: 'call',
        name: 'fs_write',
        args: { path: 'one.txt' },
        category: 'project',
        requiresApproval: true,
        status: 'proposed',
      })
      await options.toolSession!.approve('call')
      return answer
    })
    await expect(runWorkflowAgentFlow(false, { instruction: 'Schreiben' }, context, deps)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('validates structured output and does not retry invalid data', async () => {
    const { deps, context } = fixture({ finalText: '{"value":"wrong"}' })
    await expect(
      runWorkflowAgentFlow(
        false,
        {
          instruction: 'JSON',
          output_schema: { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } },
        },
        context,
        deps
      )
    ).rejects.toThrow()
    expect(deps.run).toHaveBeenCalledOnce()
  })

  it.each([
    { agent_selection: 'auto', model: 'bypass' },
    { agent_selection: 'override', agent: 'arbitrary-process' },
    { agent_selection: 'override', agent: 'local', model: 'unsigned' },
  ])('rejects unsupported overrides before any execution', async override => {
    const { deps, context } = fixture()
    await expect(runWorkflowAgentFlow(false, { instruction: 'Work', ...override }, context, deps)).rejects.toThrow()
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.managed).not.toHaveBeenCalled()
  })

  it('aborts once at the bounded deadline and waits for its executor to stop', async () => {
    vi.useFakeTimers()
    const { deps, context } = fixture()
    deps.run.mockImplementationOnce(
      options =>
        new Promise((_, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
        })
    )
    const result = runWorkflowAgentFlow(false, { instruction: 'Work', timeout_seconds: 5 }, context, deps)
    const outcome = result.catch(error => error as Error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await outcome).toMatchObject({ message: 'workflow_agent_timeout' })
    expect(deps.run).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
