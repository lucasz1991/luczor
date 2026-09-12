import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: vi.fn() }))
vi.mock('@/services/agents/hub', () => ({ agentProjectSnapshot: vi.fn() }))
vi.mock('@/services/agents/workflowAgent', () => ({ runWorkflowAgent: vi.fn() }))
vi.mock('@/services/agent', () => ({ runAgent: vi.fn() }))
import { runWorkflowAgentFlow } from '@/services/workflows/agentFlow'
import type { RunAgentOptions, RunAgentResult } from '@/services/agent'
import type { WorkflowAgentResult } from '@/services/agents/workflowAgent'
import type { WorkflowAgentAvailability } from '@/services/workflows/agentSelection'
import type { requestPayloadApproval } from '@/services/payloadApproval'
import type { readVerifiedWorkflowAgentEvidence } from '@/services/workflows/agentEvidence'

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
    managed: vi.fn<
      (
        ...args: Parameters<typeof import('@/services/agents/workflowAgent').runWorkflowAgent>
      ) => Promise<WorkflowAgentResult>
    >(async () => ({ ok: true, code: 0, stdout: 'CLI result', stderr: '' })),
    assert: vi.fn((ticket: { signal: AbortSignal }) => ticket.signal.throwIfAborted()),
    mode: () => 'act' as const,
    confirm: vi.fn(async () => ({ approved: true })),
    approve: vi.fn<typeof requestPayloadApproval>(async () => true),
    evidence: vi.fn<typeof readVerifiedWorkflowAgentEvidence>(async () => null),
    availability: vi.fn<(signal: AbortSignal) => Promise<WorkflowAgentAvailability>>(async () => ({
      externalPolicy: 'ask',
      local: { manifestAvailable: true, state: 'ready', activeModelId: 'signed-model' },
      codex: { available: false, catalog: { revision: 'unavailable', models: [] } },
      claude: { available: false, catalog: { revision: 'unavailable', models: [] } },
    })),
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
  it.each([false, true])('binds the frozen workcopy for a mirrored local/team step (team=%s)', async team => {
    const { deps, context } = fixture()
    const workflowScope = {
      principalId: 'principal',
      projectId: 'project',
      runId: '11111111-1111-4111-8111-111111111111',
      expectedRootPath: 'C:/frozen-workcopy',
      expectedWorkspaceUpdatedAt: 1,
    }
    await runWorkflowAgentFlow(
      team,
      { instruction: 'Build files', agent_selection: 'override', agent: 'local' },
      { ...context, workflowScope },
      deps
    )
    expect(deps.run).toHaveBeenCalledWith(
      expect.objectContaining({ workflowScope, execution: expect.objectContaining({ sessionId: 'session' }) })
    )
    expect(deps.managed).not.toHaveBeenCalled()
  })
  it('passes a frozen workflow directory only to the managed run while retaining source scope checks', async () => {
    const { deps, context } = fixture()
    const workflowScope = {
      principalId: 'principal',
      projectId: 'project',
      runId: '11111111-1111-4111-8111-111111111111',
      expectedRootPath: 'C:/frozen-workcopy',
      expectedWorkspaceUpdatedAt: 1,
    }
    const result = await runWorkflowAgentFlow(
      false,
      { instruction: 'Build files', agent_selection: 'override', agent: 'codex' },
      { ...context, workflowScope },
      deps
    )
    expect(result.ok).toBe(true)
    expect(deps.managed).toHaveBeenCalledWith(
      'codex',
      expect.any(String),
      'C:/frozen-workcopy',
      expect.anything(),
      'project',
      expect.objectContaining({ workflowScope })
    )
    expect(deps.run).not.toHaveBeenCalled()
  })
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
      model_confirmation: 'runtime',
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

  it.each([
    { model: undefined, inferenceTarget: 'local_llama_cpp' },
    { model: '', inferenceTarget: 'local_llama_cpp' },
    { model: 'external-model', inferenceTarget: 'laravel_proxy' },
    { model: 'unconfirmed-model', inferenceTarget: undefined },
  ] satisfies Partial<RunAgentResult>[])(
    'does not infer local runtime confirmation from availability when result identity is incomplete: %j',
    async identity => {
      const { deps, context } = fixture(identity)
      const result = await runWorkflowAgentFlow(false, { instruction: 'Analyse' }, context, deps)
      expect(result).toMatchObject({ ok: true, model_confirmation: 'unconfirmed' })
      expect(result.model).toBe(identity.model ?? null)
      expect(result.model).not.toBe('signed-model')
      expect(deps.run).toHaveBeenCalledOnce()
    }
  )

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
    expect(deps.availability).not.toHaveBeenCalled()
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
      model_confirmation: 'pinned_request',
      thinking_tier: 'ultra',
      thinking_application: 'adapter_not_confirmed',
    })
    expect(deps.run).not.toHaveBeenCalled()
    expect(deps.availability).not.toHaveBeenCalled()
  })

  it('selects and approves the exact automatic managed route, preserving actual model/effort metadata', async () => {
    const { deps, context } = fixture()
    const available = await deps.availability(context.ticket.signal)
    deps.availability.mockResolvedValue({
      ...available,
      codex: {
        available: true,
        catalog: {
          source: 'codex-cache',
          revision: 'revision',
          validForSeconds: 300,
          models: [{ model: 'real-model', supportedEfforts: ['low', 'medium', 'high'] }],
        },
      },
    })
    deps.managed.mockResolvedValue({
      ok: true,
      code: 0,
      stdout: 'Done',
      stderr: '',
      runtimeEvidence: { model: 'actual-model', modelSource: 'runtime', toolGateChecks: 2 },
      effortSelection: {
        tier: 'thorough',
        model: 'actual-model',
        requestedEffort: 'high',
        appliedEffort: 'high',
        status: 'confirmed',
        reason: 'node_override',
        capabilityRevision: 'revision',
        capabilitySource: 'runtime',
      },
    })
    const result = await runWorkflowAgentFlow(false, { instruction: 'Implementiere Code' }, context, deps)
    expect(result).toMatchObject({
      agent: 'codex',
      requested_model: 'real-model',
      model: 'actual-model',
      model_confirmation: 'runtime',
      requested_effort: 'high',
      applied_effort: 'high',
      thinking_application: 'confirmed',
      tool_gate_checks: 2,
      selection_availability: 'runtime_present_auth_unknown',
      selection_cost: 'unknown',
    })
    const packet = deps.approve.mock.calls[0]?.[0]
    expect(packet).toMatchObject({ kind: 'inference' })
    expect(JSON.parse(packet!.content)).toMatchObject({
      adapter: 'codex',
      model: 'real-model',
      effort: 'high',
      permission: 'workspace-write',
      prompt: expect.stringContaining('Implementiere Code'),
    })
    expect(deps.managed).toHaveBeenCalledExactlyOnceWith(
      'codex',
      expect.any(String),
      'C:/fixture',
      expect.any(AbortSignal),
      'project',
      expect.objectContaining({ model: 'real-model', effort: 'high', permission: 'workspace-write' })
    )
    expect(deps.approve).toHaveBeenCalledTimes(2) // Exact dispatch packet, then exact public-result export.
  })

  it.each(['denied', 'revoked', 'changed'])(
    'does not dispatch an automatic route after approval is %s',
    async failure => {
      const { deps, context, controller } = fixture()
      const base = await deps.availability(context.ticket.signal)
      const available: WorkflowAgentAvailability = {
        ...base,
        codex: {
          available: true,
          catalog: {
            source: 'codex-cache',
            revision: 'revision',
            validForSeconds: 300,
            models: [{ model: 'model', supportedEfforts: ['high'] }],
          },
        },
      }
      deps.availability.mockResolvedValue(available)
      deps.approve.mockImplementationOnce(async () => {
        if (failure === 'revoked') controller.abort()
        if (failure === 'changed') deps.availability.mockResolvedValue({ ...available, externalPolicy: 'deny' })
        return failure !== 'denied'
      })
      const result = runWorkflowAgentFlow(false, { instruction: 'Implementiere Code' }, context, deps)
      const outcome = await result.catch(() => ({ ok: false, code: 'revoked_or_changed' }))
      expect(outcome).toEqual({
        ok: false,
        code: failure === 'denied' ? 'workflow_agent_dispatch_denied' : 'revoked_or_changed',
      })
      expect(deps.managed).not.toHaveBeenCalled()
      expect(deps.run).not.toHaveBeenCalled()
    }
  )

  it('does not silently replay a failed managed route through another adapter', async () => {
    const { deps, context } = fixture()
    deps.managed.mockResolvedValue({ ok: false, code: 1, stdout: '', stderr: 'Unavailable' })
    const result = await runWorkflowAgentFlow(
      false,
      { instruction: 'Code', agent_selection: 'override', agent: 'claude' },
      context,
      deps
    )
    expect(result).toMatchObject({ ok: false, outcome: 'failed', model: null, applied_effort: null })
    expect(deps.managed).toHaveBeenCalledOnce()
    expect(deps.run).not.toHaveBeenCalled()
  })

  it('freezes the reviewed node and ignores mutated input while availability and approval are awaited', async () => {
    const { deps, context } = fixture()
    const base = await deps.availability(context.ticket.signal)
    const available: WorkflowAgentAvailability = {
      ...base,
      codex: {
        available: true,
        catalog: {
          revision: 'revision',
          source: 'codex-cache',
          validForSeconds: 300,
          models: [{ model: 'pinned-model', supportedEfforts: ['high'] }],
        },
      },
    }
    const params = {
      instruction: 'Implementiere Code',
      thinking_tier: 'thorough',
      input_bindings: { note: 'original' },
    }
    deps.availability.mockImplementation(async () => {
      params.instruction = 'different instruction'
      params.thinking_tier = 'ultra'
      params.input_bindings.note = 'mutated'
      return available
    })
    await runWorkflowAgentFlow(false, params, context, deps)
    const sent = deps.managed.mock.calls[0]
    expect(sent?.[1]).toContain('Implementiere Code')
    expect(sent?.[1]).toContain('original')
    expect(sent?.[1]).not.toContain('mutated')
    expect(sent?.[5]).toMatchObject({ model: 'pinned-model', thinkingTier: 'thorough', effort: 'high' })
    expect(JSON.parse(deps.approve.mock.calls[0]![0].content).prompt).toBe(sent?.[1])
  })

  it('rejects changed account credentials after automatic packet approval without dispatch or result export', async () => {
    const { deps, context, account } = fixture()
    const base = await deps.availability(context.ticket.signal)
    deps.availability.mockResolvedValue({
      ...base,
      codex: {
        available: true,
        catalog: {
          revision: 'revision',
          source: 'codex-cache',
          validForSeconds: 300,
          models: [{ model: 'pinned-model', supportedEfforts: ['high'] }],
        },
      },
    })
    deps.approve.mockImplementationOnce(async () => {
      deps.account.mockResolvedValue({ ...account, config: { ...account.config, clientId: 'another-device' } })
      return true
    })
    await expect(runWorkflowAgentFlow(false, { instruction: 'Implementiere Code' }, context, deps)).rejects.toThrow(
      'scope_changed'
    )
    expect(deps.managed).not.toHaveBeenCalled()
    expect(deps.approve).toHaveBeenCalledOnce()
  })

  it.each(['samples', 'scope'])('keeps the approved route stable when evidence %s changes', async change => {
    const { deps, context } = fixture()
    const base = await deps.availability(context.ticket.signal)
    deps.availability.mockResolvedValue({
      ...base,
      claude: {
        available: true,
        cliVersion: '2.1.266',
        catalog: {
          revision: 'revision',
          source: 'sdk-documentation',
          models: [{ model: 'proved-model', supportedEfforts: ['high'] }],
        },
      },
    })
    const proof = {
      version: 1 as const,
      revision: 'a'.repeat(64),
      scope_hash: 'b'.repeat(64),
      device_environment_hash: 'c'.repeat(64),
      minimum_samples: 5,
      rows: [
        {
          adapter: 'claude' as const,
          model: 'proved-model',
          model_source: 'runtime' as const,
          samples: 5,
          passed: 5,
          failed: 0,
          latest_test_at: '2026-09-08T10:00:00Z',
          evidence_ids: [1, 2, 3, 4, 5],
        },
      ],
    }
    deps.evidence.mockResolvedValueOnce(proof).mockResolvedValueOnce({
      ...proof,
      revision: 'd'.repeat(64),
      scope_hash: change === 'scope' ? 'e'.repeat(64) : proof.scope_hash,
      rows: [{ ...proof.rows[0]!, samples: 6, passed: 5, failed: 1, evidence_ids: [1, 2, 3, 4, 5, 6] }],
    })
    const result = await runWorkflowAgentFlow(
      false,
      { instruction: 'Implementiere Code' },
      { ...context, runPublicId: 'run', stepId: 1 },
      deps
    ).catch(() => ({ code: 'scope_changed' }))
    expect(result).toMatchObject(
      change === 'scope'
        ? { code: 'scope_changed' }
        : {
            agent: 'claude',
            selection_quality_evidence: 'verified_real_tests',
            selection_evidence: { revision: proof.revision, samples: 5 },
          }
    )
    expect(deps.managed).toHaveBeenCalledTimes(change === 'scope' ? 0 : 1)
    const packet = JSON.parse(deps.approve.mock.calls[0]![0].content)
    expect(packet).toMatchObject({ model: 'proved-model', evidence: { scopeHash: proof.scope_hash } })
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
    expect(deps.managed).toHaveBeenCalledExactlyOnceWith(
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
  })

  it('preserves the lower round cap for managed Claude and refuses unsupported Codex rounds', async () => {
    const { deps, context } = fixture()
    await runWorkflowAgentFlow(
      false,
      { instruction: 'Review', agent_selection: 'override', agent: 'claude', max_turns: 8, max_rounds: 3 },
      context,
      deps
    )
    await expect(
      runWorkflowAgentFlow(
        false,
        { instruction: 'Review', agent_selection: 'override', agent: 'codex', max_rounds: 3 },
        context,
        deps
      )
    ).rejects.toThrow('workflow_codex_budget_controls_unavailable')
    expect(deps.managed).toHaveBeenCalledExactlyOnceWith(
      'claude',
      expect.any(String),
      'C:/fixture',
      expect.any(AbortSignal),
      'project',
      expect.objectContaining({ maxTurns: 3 })
    )
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
