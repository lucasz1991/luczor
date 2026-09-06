import { describe, expect, it, vi } from 'vitest'
import { createModelAgentAdapter, type ModelAgentDependencies } from '@/services/agents/modelAgent'
import type { AgentRunRequest } from '@/services/agents/types'
import type { VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { hashInferenceEgressRequest, type ResolvedTurnRoute } from '@/services/inference/coordinator'
import { LocalInferenceError } from '@/services/inference/localModelManager'
import type { InferenceRequest, InferenceResult } from '@/services/inference/types'

const account: VerifiedAccountSnapshot = {
  principalId: 'account:test',
  accountId: 7,
  serverOrigin: 'https://luczor.example.test',
  serverInstance: 'https://luczor.example.test',
  config: { baseUrl: 'https://luczor.example.test', deviceKey: 'test-key', clientId: 'client-test' },
}

function result(content = 'Analyse abgeschlossen.'): InferenceResult {
  return { content, toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
}

function approvalRequired() {
  return new LocalInferenceError('Freigabe erforderlich.', 'external_approval_required', false, false)
}

function request(controller = new AbortController()): AgentRunRequest {
  return {
    jobId: 'job-test',
    project: {
      principalId: account.principalId,
      projectId: 'project-test',
      projectName: 'Testprojekt',
      rootPath: 'E:\\private-workspace',
    },
    permission: 'read-only',
    prompt: 'Prüfe den beigefügten Plan.',
    role: 'reviewer',
    signal: controller.signal,
    onOutput: vi.fn(),
  }
}

function harness() {
  const stream = vi.fn(async (_request: InferenceRequest) => result())
  const local: ResolvedTurnRoute = {
    gateway: { id: 'local-fixture', target: 'local_llama_cpp', streamChatWithTools: stream },
  }
  const external: ResolvedTurnRoute = {
    gateway: { id: 'proxy-fixture', target: 'laravel_proxy', streamChatWithTools: stream },
    externalOneShot: true,
  }
  const resolveRoute = vi.fn<ModelAgentDependencies['resolveRoute']>().mockResolvedValue(local)
  const accountSnapshot = vi.fn<ModelAgentDependencies['accountSnapshot']>().mockResolvedValue(account)
  const externalPolicy = vi.fn<ModelAgentDependencies['externalPolicy']>().mockResolvedValue('ask')
  const dependencies: ModelAgentDependencies = { resolveRoute, accountSnapshot, externalPolicy, now: () => 1_000_000 }
  return { dependencies, resolveRoute, accountSnapshot, externalPolicy, stream, local, external }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { resolve, promise }
}

describe('project model-agent adapter', () => {
  it('uses signed local-only routing, no tools and only the reviewed prompt', async () => {
    const fixture = harness()
    const input = request()
    const adapter = createModelAgentAdapter({ id: 'local' }, fixture.dependencies)
    expect(adapter.permissions).toEqual(['read-only'])
    expect(await adapter.run(input)).toEqual({ output: 'Analyse abgeschlossen.' })
    expect(fixture.resolveRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        contextEgress: 'local_only',
        routingSettings: { preference: 'local_only' },
        taskType: 'verification.agent',
      })
    )
    expect(fixture.externalPolicy).not.toHaveBeenCalled()
    const wire = fixture.stream.mock.calls[0]![0]
    expect(wire.tools).toEqual([])
    expect(wire.toolChoice).toBe('none')
    expect(wire.messages[1]).toEqual({ role: 'user', content: input.prompt })
    expect(JSON.stringify(wire)).not.toContain(input.project.rootPath)
    expect(wire.signal).toBe(input.signal)
  })

  it.each([
    ['planner', 'planning.agent'],
    ['implementer', 'coding.agent'],
    ['reviewer', 'verification.agent'],
    ['assistant', 'chat.agent'],
  ] as const)('maps the %s role to the server-owned %s use case', async (role, taskType) => {
    const fixture = harness()
    await createModelAgentAdapter({ id: 'policy' }, fixture.dependencies).run({ ...request(), role })
    expect(fixture.stream.mock.calls[0]![0].taskType).toBe(taskType)
  })

  it('binds one external generation to the exact reviewed packet and current account', async () => {
    const fixture = harness()
    fixture.resolveRoute.mockRejectedValueOnce(approvalRequired()).mockResolvedValueOnce(fixture.external)
    const approve = vi.fn(async () => true)
    await createModelAgentAdapter({ id: 'policy', requestExternalApproval: approve }, fixture.dependencies).run(
      request()
    )
    const input = fixture.resolveRoute.mock.calls[1]![0]
    const packet = input.externalPackage!
    expect(packet.packetHash).toBe(
      await hashInferenceEgressRequest(fixture.stream.mock.calls[0]![0], account.config.clientId)
    )
    expect(packet.approval.packetHash).toBe(packet.packetHash)
    expect(packet.apiConfig).toEqual(account.config)
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: account.config.baseUrl,
        packetHash: packet.packetHash,
        toolsAllowed: false,
        taskType: 'verification.agent',
      })
    )
    expect(fixture.stream).toHaveBeenCalledTimes(1)
  })

  it('does not start an external request when consent is declined', async () => {
    const fixture = harness()
    fixture.resolveRoute.mockRejectedValue(approvalRequired())
    await expect(
      createModelAgentAdapter({ id: 'policy', requestExternalApproval: () => false }, fixture.dependencies).run(
        request()
      )
    ).rejects.toThrow('abgelehnt')
    expect(fixture.stream).not.toHaveBeenCalled()
  })

  it('does not permit a direct proxy route or bypass denied repository policy', async () => {
    const fixture = harness()
    fixture.externalPolicy.mockResolvedValue('deny')
    fixture.resolveRoute.mockResolvedValue(fixture.external)
    await expect(createModelAgentAdapter({ id: 'policy' }, fixture.dependencies).run(request())).rejects.toThrow(
      'Paketfreigabe'
    )
    expect(fixture.resolveRoute.mock.calls[0]![0].contextEgress).toBe('local_only')
    expect(fixture.stream).not.toHaveBeenCalled()
  })

  it('rechecks account and egress policy after the approval dialog', async () => {
    const fixture = harness()
    fixture.resolveRoute.mockRejectedValueOnce(approvalRequired()).mockResolvedValueOnce(fixture.external)
    const approve = () => {
      fixture.externalPolicy.mockResolvedValue('deny')
      return true
    }
    await expect(
      createModelAgentAdapter({ id: 'policy', requestExternalApproval: approve }, fixture.dependencies).run(request())
    ).rejects.toThrow('Richtlinie')
    expect(fixture.stream).not.toHaveBeenCalled()
  })

  it('rejects a changed device identity even when the principal did not change', async () => {
    const fixture = harness()
    fixture.accountSnapshot
      .mockResolvedValueOnce(account)
      .mockResolvedValue({ ...account, config: { ...account.config, deviceKey: 'changed-key' } })
    await expect(createModelAgentAdapter({ id: 'local' }, fixture.dependencies).run(request())).rejects.toThrow(
      'geändert'
    )
    expect(fixture.stream).not.toHaveBeenCalled()
  })

  it('rejects missing or cross-account principals before selecting any route', async () => {
    const fixture = harness()
    await expect(
      createModelAgentAdapter({ id: 'local' }, fixture.dependencies).run({
        ...request(),
        project: { ...request().project, principalId: 'other' },
      })
    ).rejects.toThrow('Konto')
    expect(fixture.resolveRoute).not.toHaveBeenCalled()
  })

  it('cancels an outstanding approval promptly and ignores a late approval', async () => {
    const fixture = harness()
    fixture.resolveRoute.mockRejectedValue(approvalRequired())
    const entered = deferred<void>()
    const approval = deferred<boolean>()
    const controller = new AbortController()
    const running = createModelAgentAdapter(
      {
        id: 'policy',
        requestExternalApproval: () => {
          entered.resolve()
          return approval.promise
        },
      },
      fixture.dependencies
    ).run(request(controller))
    await entered.promise
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    approval.resolve(true)
    await Promise.resolve()
    expect(fixture.resolveRoute).toHaveBeenCalledTimes(1)
    expect(fixture.stream).not.toHaveBeenCalled()
  })

  it('retains the runtime slot until the gateway acknowledges cancellation', async () => {
    const fixture = harness()
    const started = deferred<InferenceRequest>()
    const stopped = deferred<InferenceResult>()
    fixture.stream.mockImplementation(async input => {
      started.resolve(input)
      return stopped.promise
    })
    const controller = new AbortController()
    const input = request(controller)
    const running = createModelAgentAdapter({ id: 'local' }, fixture.dependencies).run(input)
    let settled = false
    const observed = running.finally(() => {
      settled = true
    })
    const wire = await started.promise
    controller.abort()
    wire.onToken?.('Late output')
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(input.onOutput).not.toHaveBeenCalled()
    stopped.resolve(result('Late result'))
    await expect(observed).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects expired consent before a second route is acquired', async () => {
    const fixture = harness()
    fixture.resolveRoute.mockRejectedValue(approvalRequired())
    const approve = () => {
      fixture.dependencies.now = () => 1_500_000
      return true
    }
    await expect(
      createModelAgentAdapter({ id: 'policy', requestExternalApproval: approve }, fixture.dependencies).run(request())
    ).rejects.toThrow('abgelaufen')
    expect(fixture.resolveRoute).toHaveBeenCalledTimes(1)
    expect(fixture.stream).not.toHaveBeenCalled()
  })

  it('does not retry policy failures or execute model-supplied tool calls', async () => {
    const fixture = harness()
    fixture.stream.mockResolvedValue({
      ...result(),
      toolCalls: [{ id: 'tool', name: 'agent_dispatch', arguments: {}, rawArguments: '{}' }],
    })
    await expect(createModelAgentAdapter({ id: 'local' }, fixture.dependencies).run(request())).rejects.toThrow(
      'kein Werkzeug ausgeführt'
    )
    expect(fixture.stream).toHaveBeenCalledTimes(1)
    fixture.resolveRoute.mockRejectedValue(
      new LocalInferenceError('Policy unavailable', 'local_policy_unavailable', false, false)
    )
    const approve = vi.fn(() => true)
    await expect(
      createModelAgentAdapter({ id: 'policy', requestExternalApproval: approve }, fixture.dependencies).run(request())
    ).rejects.toThrow('Policy unavailable')
    expect(approve).not.toHaveBeenCalled()
  })

  it('bounds output snapshots and refuses empty responses', async () => {
    const fixture = harness()
    const input = request()
    fixture.stream.mockImplementation(async wire => {
      wire.onToken?.('a'.repeat(100_000))
      return result('b'.repeat(100_000))
    })
    const response = await createModelAgentAdapter({ id: 'local' }, fixture.dependencies).run(input)
    expect(response.output.length).toBe(64_000)
    expect(vi.mocked(input.onOutput).mock.calls[0]![0].length).toBe(64_000)
    fixture.stream.mockResolvedValue(result(' '))
    await expect(createModelAgentAdapter({ id: 'local' }, fixture.dependencies).run(request())).rejects.toThrow(
      'kein verwertbares Ergebnis'
    )
  })

  it.each([
    { permission: 'workspace-write' as const },
    { model: 'arbitrary-provider/model' },
    { prompt: '' },
    { prompt: 'a'.repeat(32_001) },
  ])('rejects unsupported work before accessing the account', async override => {
    const fixture = harness()
    await expect(
      createModelAgentAdapter({ id: 'local' }, fixture.dependencies).run({ ...request(), ...override })
    ).rejects.toThrow()
    expect(fixture.accountSnapshot).not.toHaveBeenCalled()
  })
})
