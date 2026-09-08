import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/state/types'
import type { ToolContext } from '@/services/tools/types'

const mocks = vi.hoisted(() => ({ config: vi.fn(), identity: vi.fn(), principal: vi.fn(), api: vi.fn(), get: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@/services/api/luczorApi', () => ({ getApiConfigSnapshot: mocks.config }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mocks.identity }))
vi.mock('@/services/projectWorkspace', () => ({ resolveWorkspacePrincipalId: mocks.principal }))
vi.mock('@/services/workflows/api', () => ({ createWorkflowApi: mocks.api }))

import { captureWorkflowAccess } from '@/services/workflows/access'
import { executionGate, updateExecutionControls } from '@/services/executionGate'
import { state } from '@/state/store'
import { DEFAULT_STATE } from '@/state/defaults'

const config = { baseUrl: 'https://example.test', deviceKey: 'private-key', clientId: 'desktop-a' }
let generation = 0
function project(id: string): Project {
  return { ...structuredClone(DEFAULT_STATE.projects[0]!), id, name: id }
}
function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { projectId: 'selected', inferenceTarget: 'local', execution: executionGate.capture(), ...overrides }
}
function workspace(overrides: Partial<ToolContext> = {}) {
  return context({ workspaceScope: { principalId: 'account-a', projectIds: ['selected', 'target'] }, ...overrides })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.projects = [project('selected'), project('target')]
  updateExecutionControls({ mode: 'act', killSwitch: false, scope: `workflow-access-${++generation}` })
  mocks.config.mockResolvedValue({ ...config })
  mocks.identity.mockResolvedValue({ principalId: 'account-a', config: { ...config } })
  mocks.principal.mockResolvedValue('account-a')
  mocks.api.mockReturnValue({ get: mocks.get })
  mocks.get.mockResolvedValue({ data: { id: 4, project_external_id: 'selected' } })
})

describe('workflow chat access boundaries', () => {
  it('binds project chat implicitly to its current project and rejects another project', async () => {
    const access = await captureWorkflowAccess(context(), undefined, true)
    expect(access.projectId).toBe('selected')
    await expect(access.workflow(4)).resolves.toMatchObject({ id: 4 })
    await expect(captureWorkflowAccess(context(), 'target', false)).rejects.toThrow('aktuelle Projekt')
  })
  it('requires an explicit allowed local workspace project, independently of the selected project', async () => {
    await expect(captureWorkflowAccess(workspace(), undefined, false)).rejects.toThrow('ausdrücklich')
    await expect(captureWorkflowAccess(workspace(), 'target', true)).resolves.toMatchObject({ projectId: 'target' })
    await expect(captureWorkflowAccess(workspace({ inferenceTarget: 'external' }), 'target', false)).rejects.toThrow(
      'Arbeitsbereich'
    )
    await expect(
      captureWorkflowAccess(
        workspace({ workspaceScope: { principalId: 'account-a', projectIds: ['selected'] } }),
        'target',
        false
      )
    ).rejects.toThrow('Arbeitsbereich')
  })
  it('rechecks account connection and workspace principal after asynchronous boundaries', async () => {
    const access = await captureWorkflowAccess(workspace(), 'target', true)
    mocks.config.mockResolvedValue({ ...config, deviceKey: 'other-account-key' })
    await expect(access.check()).rejects.toThrow('Kontoverbindung')
    mocks.config.mockResolvedValue({ ...config })
    mocks.principal.mockResolvedValue('account-b')
    await expect(access.check()).rejects.toThrow('Konto wurde geändert')
  })
  it('cannot publish a workflow fetched after the execution session was invalidated', async () => {
    const access = await captureWorkflowAccess(context(), undefined, false)
    mocks.get.mockImplementation(async () => {
      executionGate.invalidate()
      return { data: { id: 4, project_external_id: 'selected' } }
    })
    await expect(access.workflow(4)).rejects.toThrow('verworfen')
  })
  it('fails closed for unavailable projects, unverified accounts and foreign workflow DTOs', async () => {
    state.projects[0]!.archivedAt = 1
    await expect(captureWorkflowAccess(context(), undefined, false)).rejects.toThrow('Zielprojekt')
    state.projects[0]!.archivedAt = null
    mocks.identity.mockResolvedValueOnce(null)
    await expect(captureWorkflowAccess(context(), undefined, false)).rejects.toThrow('verifizierte')
    const access = await captureWorkflowAccess(context(), undefined, false)
    mocks.get.mockResolvedValueOnce({ data: { id: 4, project_external_id: 'target' } })
    await expect(access.workflow(4)).rejects.toThrow('anderen Projekt')
  })
  it('blocks writes in observe mode while permitting reads and later rejects archived targets', async () => {
    updateExecutionControls({ mode: 'observe', killSwitch: false, scope: 'read-only' })
    await expect(captureWorkflowAccess(context(), undefined, true)).rejects.toThrow('Beobachten')
    const access = await captureWorkflowAccess(context(), undefined, false)
    state.projects[0]!.archivedAt = 1
    await expect(access.check()).rejects.toThrow('Zielprojekt')
  })
})
