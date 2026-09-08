import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workflow } from '@/services/workflows/types'

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  check: vi.fn(),
  workflow: vi.fn(),
  prepare: vi.fn(),
  publish: vi.fn(),
  secret: vi.fn(),
  store: { get: vi.fn(), set: vi.fn(), save: vi.fn() },
  api: {
    create: vi.fn(),
    update: vi.fn(),
    start: vi.fn(),
    operation: vi.fn(),
    run: vi.fn(),
    cancel: vi.fn(),
    triggers: vi.fn(),
    saveTrigger: vi.fn(),
    catalog: vi.fn(),
    revision: vi.fn(),
  },
}))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => mocks.store } }))
vi.mock('@/services/workflows/access', () => ({ captureWorkflowAccess: mocks.access }))
vi.mock('@/services/tools/shared', () => ({ ensureCurrentProjectOnServer: mocks.prepare }))
vi.mock('@/services/workflows/presentation', () => ({
  publishWorkflowChange: mocks.publish,
  retainWorkflowSecret: mocks.secret,
}))
vi.mock('@/services/prompt/promptContextAssembler', () => ({ redactProviderSecrets: (value: string) => value }))

import { workflowTools } from '@/services/tools/workflows'
import { workflowDigest } from '@/services/workflows/operations'

const workflow: Workflow = {
  id: 7,
  name: 'Private workflow',
  version: 2,
  project_id: 5,
  project_external_id: 'target',
  status: 'active',
  is_locked: false,
  definition: { steps: [{ key: 'summarize', type: 'llm', payload: { instruction: 'Summarize locally' } }] },
}
const context = { projectId: 'selected' }
let saved: unknown = []
function tool(name: string) {
  const found = workflowTools.find(item => item.name === name)
  if (!found) throw new Error(`Missing workflow tool ${name}`)
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  saved = []
  mocks.store.get.mockImplementation(async () => structuredClone(saved))
  mocks.store.set.mockImplementation(async (_key: string, value: unknown) => {
    saved = structuredClone(value)
  })
  mocks.store.save.mockResolvedValue(undefined)
  mocks.check.mockResolvedValue(undefined)
  mocks.prepare.mockResolvedValue(undefined)
  mocks.workflow.mockResolvedValue(structuredClone(workflow))
  mocks.access.mockResolvedValue({
    projectId: 'target',
    principalId: 'account-a',
    config: { clientId: 'desktop-a', deviceKey: 'private-device-key', baseUrl: 'https://example.test' },
    execution: { signal: new AbortController().signal },
    check: mocks.check,
    api: mocks.api,
    workflow: mocks.workflow,
  })
  mocks.api.create.mockResolvedValue({ data: structuredClone(workflow) })
  mocks.api.update.mockResolvedValue({ data: structuredClone(workflow) })
  mocks.api.operation.mockResolvedValue({ data: { status: 'not_found' } })
  mocks.api.triggers.mockResolvedValue({ data: [{ id: 21 }] })
})

describe('conversational workflow tools', () => {
  it('creates only a saved definition in the captured project and publishes the reference', async () => {
    const result = await tool('workflow_create').execute(
      { name: workflow.name, definition: workflow.definition },
      context
    )
    expect(mocks.api.create).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'target', operation_id: expect.any(String) })
    )
    expect(mocks.api.start).not.toHaveBeenCalled()
    expect(mocks.api.saveTrigger).not.toHaveBeenCalled()
    expect(mocks.publish).toHaveBeenCalledWith('target', 7)
    expect(result).toMatchObject({ ok: true, workflow_ref: { id: 7, version: 2 } })
    expect(tool('workflow_create').requiresApproval).toBe(true)
    await expect(
      tool('workflow_create').execute(
        { name: 'Wrong scope', definition: workflow.definition, device_id: 'attacker' },
        context
      )
    ).rejects.toThrow('Unbekanntes Feld')
  })
  it('passes the caller expected version without silently refreshing it', async () => {
    await tool('workflow_update').execute(
      {
        workflow_id: 7,
        expected_version: 1,
        name: workflow.name,
        definition: workflow.definition,
        change_summary: 'Review changes',
      },
      context
    )
    expect(mocks.api.update).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ expected_version: 1, change_summary: 'Review changes' })
    )
  })
  it('recovers the raw backend operation response after a lost reply without duplicate creation', async () => {
    const args = { name: workflow.name, definition: workflow.definition }
    mocks.api.create.mockRejectedValueOnce(new Error('connection closed'))
    const uncertain = await tool('workflow_create').execute(args, context)
    expect(uncertain).toMatchObject({
      ok: false,
      code: 'workflow_operation_outcome_unknown',
      retry: 'verify_before_retry',
    })
    expect(JSON.stringify(saved)).not.toContain('private-device-key')
    expect(JSON.stringify(saved)).not.toContain(workflow.name)
    expect(JSON.stringify(saved)).not.toContain('account-a')
    expect(saved).toEqual([
      expect.objectContaining({
        scope: await workflowDigest({
          principal: 'account-a',
          project: 'target',
          path: 'create',
          server: 'https://example.test',
          device: 'desktop-a',
        }),
      }),
    ])
    mocks.api.operation.mockResolvedValueOnce({ data: { status: 'completed', response: structuredClone(workflow) } })
    await expect(tool('workflow_create').execute(args, context)).resolves.toMatchObject({
      ok: true,
      workflow_ref: { id: 7 },
    })
    expect(mocks.api.create).toHaveBeenCalledOnce()
    expect(mocks.api.operation).toHaveBeenCalledOnce()
    expect(saved).toEqual([])
  })
  it('binds run dispatch to the captured device and defaults real execution only on the start tool', async () => {
    mocks.api.start.mockResolvedValueOnce({
      data: { id: 2, public_id: 'run-2', workflow_definition_id: 7, status: 'running', sandbox: true },
    })
    await tool('workflow_run_start').execute({ workflow_id: 7, sandbox: true, input: { topic: 'Review' } }, context)
    expect(mocks.api.start).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        device_id: 'desktop-a',
        project_id: 'target',
        sandbox: true,
        input: { topic: 'Review' },
      })
    )
  })
  it('keeps webhook secrets local and preserves unspecified enabled state on trigger edits', async () => {
    mocks.api.saveTrigger.mockResolvedValueOnce({
      data: { id: 21, name: 'Hook', enabled: true, webhook_secret: 'private-webhook-secret' },
    })
    const result = await tool('workflow_trigger_save').execute(
      { workflow_id: 7, trigger_id: 21, name: 'Hook', kind: 'webhook', config: {} },
      context
    )
    const body = mocks.api.saveTrigger.mock.calls[0]![1] as Record<string, unknown>
    expect(body).not.toHaveProperty('enabled')
    expect(body).not.toHaveProperty('input')
    expect(mocks.secret).toHaveBeenCalledWith(21, 'private-webhook-secret')
    expect(JSON.stringify(result)).not.toContain('private-webhook-secret')
  })
  it('rejects a run from another workflow before cancellation', async () => {
    mocks.api.run.mockResolvedValueOnce({ data: { public_id: 'other-run', workflow_definition_id: 99 } })
    await expect(tool('workflow_run_cancel').execute({ workflow_id: 7, run_id: 'other-run' }, context)).rejects.toThrow(
      'anderen Workflow'
    )
    expect(mocks.api.cancel).not.toHaveBeenCalled()
  })
  it('labels historical run references with their frozen version and leaves unknown legacy versions unset', async () => {
    const run = {
      public_id: 'old-run',
      workflow_definition_id: 7,
      status: 'completed',
      sandbox: false,
      definition_version: 1,
    }
    mocks.api.run.mockResolvedValueOnce({ data: run })
    await expect(
      tool('workflow_run_get').execute({ workflow_id: 7, run_id: 'old-run' }, context)
    ).resolves.toMatchObject({
      ok: true,
      run: { definition_version: 1 },
      workflow_ref: { id: 7, version: 1 },
    })
    mocks.api.run.mockResolvedValueOnce({ data: { ...run, definition_version: null } })
    const legacy = await tool('workflow_run_get').execute({ workflow_id: 7, run_id: 'old-run' }, context)
    expect(legacy).toMatchObject({ workflow_ref: { version: undefined } })
  })
  it('keeps recursive grant previews out of model results while allowing valid nested definitions to be read', async () => {
    mocks.workflow.mockResolvedValueOnce({
      ...structuredClone(workflow),
      expanded_snapshot: { hugePrivatePreview: 'x'.repeat(300_000) },
    })
    const result = await tool('workflow_get').execute({ workflow_id: 7 }, context)
    expect(result).toMatchObject({ ok: true, workflow: { id: 7, definition: workflow.definition } })
    expect(JSON.stringify(result)).not.toContain('hugePrivatePreview')
  })
})
