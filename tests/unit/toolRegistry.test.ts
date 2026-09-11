import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Public tool arguments intentionally use x/y coordinate names. */
/* eslint id-length: ['error', { exceptions: ['x', 'y'] }] */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setProjectSummary: vi.fn(),
  upsertGoal: vi.fn(),
  addProject: vi.fn(),
  rollbackProjectCreation: vi.fn(),
  saveAppStateStrict: vi.fn(),
  enqueueProjectSync: vi.fn(),
  commitProjectSync: vi.fn(),
  flushProjectSyncQueue: vi.fn(),
  createProject: vi.fn(),
  getConfigSnapshot: vi.fn(),
  requestWithConfig: vi.fn(),
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  verifyConversationCreate: vi.fn(),
  createTask: vi.fn(),
  listTasks: vi.fn(),
  verifyTaskCreate: vi.fn(),
  updateTask: vi.fn(),
  detectAgents: vi.fn(),
  runAgentCli: vi.fn(),
  prepareAgentJob: vi.fn(),
  agentProjectSnapshot: vi.fn(),
  writeBridgeFile: vi.fn(),
  buildBridgeMarkdown: vi.fn(),
  setPlan: vi.fn(),
  getPlan: vi.fn(),
  assertPlanPrincipal: vi.fn(),
  planProgress: vi.fn(),
  currentPlanStep: vi.fn(),
  getProjectWorkspace: vi.fn(),
  requireProjectWorkspace: vi.fn(),
  resolveWorkspacePrincipalId: vi.fn(),
  getRepositoryExternalPolicy: vi.fn(),
  state: { projects: [] as unknown[] },
  apiConfig: { baseUrl: 'https://luczor.test', deviceKey: 'test-key', clientId: 'test-client' },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/state/store', () => ({
  state: mocks.state,
  mutations: {
    upsertGoal: mocks.upsertGoal,
    setProjectSummary: mocks.setProjectSummary,
    addProject: mocks.addProject,
    rollbackProjectCreation: mocks.rollbackProjectCreation,
  },
}))
vi.mock('@/services/persistence', () => ({ saveAppStateStrict: mocks.saveAppStateStrict }))
vi.mock('@/services/api/luczorApi', () => ({
  LuczorApi: {
    getConfigSnapshot: mocks.getConfigSnapshot,
    createProject: mocks.createProject,
    createConversation: mocks.createConversation,
    listConversations: mocks.listConversations,
    verifyConversationCreate: mocks.verifyConversationCreate,
    createTask: mocks.createTask,
    listTasks: mocks.listTasks,
    verifyTaskCreate: mocks.verifyTaskCreate,
    updateTask: mocks.updateTask,
  },
  requestWithConfig: mocks.requestWithConfig,
}))
vi.mock('@/services/payloadApproval', () => ({ requestPayloadApproval: vi.fn() }))
vi.mock('@/services/api/projectSyncQueue', () => ({
  enqueueProjectSync: mocks.enqueueProjectSync,
  commitProjectSync: mocks.commitProjectSync,
  flushProjectSyncQueue: mocks.flushProjectSyncQueue,
}))
vi.mock('@/services/agents', () => ({
  detectAgents: mocks.detectAgents,
  runAgentCli: mocks.runAgentCli,
  writeBridgeFile: mocks.writeBridgeFile,
  buildBridgeMarkdown: mocks.buildBridgeMarkdown,
}))
vi.mock('@/services/agents/hub', () => ({
  prepareAgentJob: mocks.prepareAgentJob,
  agentProjectSnapshot: mocks.agentProjectSnapshot,
  validateAgentScope: vi.fn(),
}))
vi.mock('@/services/projectWorkspace', () => ({
  getProjectWorkspace: mocks.getProjectWorkspace,
  requireProjectWorkspace: mocks.requireProjectWorkspace,
  resolveWorkspacePrincipalId: mocks.resolveWorkspacePrincipalId,
}))
vi.mock('@/services/repositoryGraph', () => ({
  getRepositoryExternalPolicy: mocks.getRepositoryExternalPolicy,
}))
vi.mock('@/services/plan', () => ({
  assertPlanPrincipal: mocks.assertPlanPrincipal,
  setPlan: mocks.setPlan,
  getPlan: mocks.getPlan,
  planProgress: mocks.planProgress,
  currentPlanStep: mocks.currentPlanStep,
}))

import { getTool, lastScreenshot, listTools, toOpenAITools } from '@/services/tools/registry'
import { executionGate, executionPayload, updateExecutionControls } from '@/services/executionGate'

const TOOL_CONTRACT = [
  { name: 'project_get_state', category: 'project', mutating: false, requiresApproval: false },
  { name: 'project_set_summary', category: 'project', mutating: true, requiresApproval: true },
  { name: 'project_upsert_goal', category: 'project', mutating: true, requiresApproval: true },
  { name: 'workspace_get', category: 'project', mutating: false, requiresApproval: true },
  { name: 'fs_list', category: 'app', mutating: false, requiresApproval: true },
  { name: 'fs_stat', category: 'app', mutating: false, requiresApproval: true },
  { name: 'fs_read', category: 'app', mutating: false, requiresApproval: true },
  { name: 'fs_search', category: 'app', mutating: false, requiresApproval: true },
  { name: 'fs_write', category: 'app', mutating: true, requiresApproval: true },
  { name: 'fs_create_dir', category: 'app', mutating: true, requiresApproval: true },
  { name: 'fs_move', category: 'app', mutating: true, requiresApproval: true },
  { name: 'fs_delete', category: 'app', mutating: true, requiresApproval: true },
  { name: 'os_system_diagnostics', category: 'os', mutating: false, requiresApproval: true },
  { name: 'os_read_clipboard', category: 'os', mutating: false, requiresApproval: true },
  { name: 'os_list_windows', category: 'os', mutating: false, requiresApproval: true },
  { name: 'os_screen_capture', category: 'os', mutating: false, requiresApproval: true },
  { name: 'os_move_mouse', category: 'os', mutating: true, requiresApproval: true },
  { name: 'os_click', category: 'os', mutating: true, requiresApproval: true },
  { name: 'os_type_text', category: 'os', mutating: true, requiresApproval: true },
  { name: 'os_press_key', category: 'os', mutating: true, requiresApproval: true },
  { name: 'os_scroll', category: 'os', mutating: true, requiresApproval: true },
  { name: 'os_hotkey', category: 'os', mutating: true, requiresApproval: true },
  { name: 'os_open_url', category: 'os', mutating: true, requiresApproval: true },
  { name: 'os_environment', category: 'os', mutating: false, requiresApproval: true },
  { name: 'os_observe_desktop', category: 'os', mutating: false, requiresApproval: true },
  { name: 'browser_close', category: 'app', mutating: true, requiresApproval: true },
  { name: 'browser_open', category: 'app', mutating: true, requiresApproval: true },
  { name: 'browser_navigate', category: 'app', mutating: true, requiresApproval: true },
  { name: 'browser_dom_read', category: 'app', mutating: false, requiresApproval: true },
  { name: 'browser_screenshot', category: 'app', mutating: false, requiresApproval: true },
  { name: 'browser_click', category: 'app', mutating: true, requiresApproval: true },
  { name: 'browser_fill', category: 'app', mutating: true, requiresApproval: true },
  { name: 'browser_select', category: 'app', mutating: true, requiresApproval: true },
  { name: 'browser_download', category: 'app', mutating: true, requiresApproval: true },
  { name: 'image_analyze', category: 'app', mutating: false, requiresApproval: true },
  { name: 'project_terminal_run', category: 'project', mutating: true, requiresApproval: true },
  { name: 'model_capabilities', category: 'app', mutating: false, requiresApproval: false },
  { name: 'model_control_validate', category: 'app', mutating: false, requiresApproval: false },
  { name: 'local_model_status', category: 'app', mutating: false, requiresApproval: false },
  { name: 'project_create', category: 'project', mutating: true, requiresApproval: true },
  { name: 'chat_create', category: 'app', mutating: true, requiresApproval: true },
  { name: 'chat_list', category: 'app', mutating: false, requiresApproval: false },
  { name: 'task_create', category: 'app', mutating: true, requiresApproval: true },
  { name: 'task_list', category: 'app', mutating: false, requiresApproval: false },
  { name: 'task_update', category: 'app', mutating: true, requiresApproval: true },
  { name: 'task_complete', category: 'app', mutating: true, requiresApproval: true },
  { name: 'agent_detect', category: 'app', mutating: false, requiresApproval: false },
  { name: 'agent_dispatch', category: 'app', mutating: true, requiresApproval: true },
  { name: 'agent_bridge_write', category: 'app', mutating: true, requiresApproval: true },
  { name: 'agent_job_prepare', category: 'app', mutating: true, requiresApproval: false },
  { name: 'agent_job_status', category: 'app', mutating: false, requiresApproval: true },
  { name: 'agent_job_cancel', category: 'app', mutating: true, requiresApproval: false },
  { name: 'agent_team_prepare', category: 'app', mutating: true, requiresApproval: false },
  { name: 'agent_team_status', category: 'app', mutating: false, requiresApproval: false },
  { name: 'agent_team_cancel', category: 'app', mutating: true, requiresApproval: false },
  { name: 'plan_update', category: 'app', mutating: false, requiresApproval: false },
  { name: 'plan_get', category: 'app', mutating: false, requiresApproval: false },
  { name: 'workflow_catalog', category: 'app', mutating: false, requiresApproval: false },
  { name: 'workflow_list', category: 'app', mutating: false, requiresApproval: false },
  { name: 'workflow_get', category: 'app', mutating: false, requiresApproval: false },
  { name: 'workflow_validate', category: 'app', mutating: false, requiresApproval: false },
  { name: 'workflow_create', category: 'app', mutating: true, requiresApproval: true },
  { name: 'workflow_update', category: 'app', mutating: true, requiresApproval: true },
  { name: 'workflow_run_start', category: 'app', mutating: true, requiresApproval: true },
  { name: 'workflow_run_get', category: 'app', mutating: false, requiresApproval: false },
  { name: 'workflow_run_cancel', category: 'app', mutating: true, requiresApproval: true },
  { name: 'workflow_trigger_list', category: 'app', mutating: false, requiresApproval: false },
  { name: 'workflow_trigger_save', category: 'app', mutating: true, requiresApproval: true },
  { name: 'workflow_trigger_delete', category: 'app', mutating: true, requiresApproval: true },
  { name: 'workflow_automation_configure', category: 'app', mutating: true, requiresApproval: true },
  { name: 'memory_recall', category: 'project', mutating: false, requiresApproval: false },
  { name: 'memory_analyze', category: 'project', mutating: false, requiresApproval: false },
  { name: 'memory_remember', category: 'project', mutating: true, requiresApproval: true },
  { name: 'workspace_overview', category: 'app', mutating: false, requiresApproval: false },
  { name: 'workspace_project_update', category: 'app', mutating: true, requiresApproval: true },
  { name: 'workspace_chat_read', category: 'app', mutating: false, requiresApproval: true },
  { name: 'workspace_agent_prepare', category: 'app', mutating: true, requiresApproval: false },
  { name: 'workspace_agent_status', category: 'app', mutating: false, requiresApproval: true },
  { name: 'workspace_agent_cancel', category: 'app', mutating: true, requiresApproval: false },
] as const

// Reviewed additions: managed effort and versioned workflows with bounded execution budgets.
const TOOL_SCHEMA_SHA256 = 'a6013bb8594cda4465759efc8304914542a56424a1f3e5890062a6c6e24ea8c3'
const CORE_TOOL_SCHEMA_SHA256 = '7aca890677b09811f1135913e1e525d88c6defdb5d955b90ccf4145e6386dd04'
const PROJECT_CONTEXT = { projectId: 'project-1' }

describe('tool registry contract', () => {
  it('keeps chat workflow definitions compatible with the versioned editor and bounded budgets', () => {
    const schema = toOpenAITools().find(item => item.function.name === 'workflow_create')!.function.parameters
    expect(schema).toMatchObject({
      properties: {
        definition: {
          properties: {
            schema_version: { enum: [1, 2] },
            thinking_tier: { enum: ['fast', 'balanced', 'thorough', 'max', 'ultra'] },
            budgets: {
              additionalProperties: false,
              properties: {
                active_seconds: { maximum: 2700 },
                max_executions: { maximum: 200 },
                max_loop_iterations: { maximum: 10 },
                max_parallel: { maximum: 2 },
                max_repairs: { minimum: 0, maximum: 2 },
              },
            },
            steps: { items: { properties: { version: { enum: [1] } } } },
          },
        },
      },
    })
  })
  it('exposes reviewed Claude and effort options without granting execution through preparation', () => {
    const tool = getTool('agent_job_prepare')!
    expect(tool.requiresApproval).toBe(false)
    const schema = toOpenAITools().find(item => item.function.name === 'agent_job_prepare')!.function.parameters
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ['agent', 'prompt'],
      properties: {
        agent: { enum: ['codex', 'claude', 'local', 'policy'] },
        thinking_tier: { enum: ['fast', 'balanced', 'thorough', 'max', 'ultra'] },
        effort: { enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        model: { type: 'string', maxLength: 160 },
        max_turns: { type: 'integer', minimum: 1, maximum: 200 },
        max_budget_usd: { type: 'number', exclusiveMinimum: 0, maximum: 100 },
      },
    })
    expect(tool.description).toContain('Does not execute it')
    expect(tool.description).toContain('not a filesystem sandbox')
  })
  beforeEach(async () => {
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'project-1' })
    await executionPayload(executionGate.capture(), false)
    vi.clearAllMocks()
    lastScreenshot.value = null
    mocks.createProject.mockResolvedValue({ data: {} })
    mocks.enqueueProjectSync.mockResolvedValue({ scopeId: 'scope', operationId: 'operation', externalId: 'project' })
    mocks.commitProjectSync.mockImplementation(async (_staged, commit: () => void) => commit())
    mocks.flushProjectSyncQueue.mockResolvedValue({ attempted: 1, synced: 1, pending: 0 })
    mocks.saveAppStateStrict.mockResolvedValue(undefined)
    mocks.getConfigSnapshot.mockResolvedValue(mocks.apiConfig)
    mocks.createConversation.mockResolvedValue({ data: { external_id: 'chat-1' } })
    mocks.listConversations.mockResolvedValue({ data: [{ external_id: 'chat-1' }] })
    mocks.verifyConversationCreate.mockResolvedValue({
      data: { external_id: 'chat-1', exists: true },
      meta: { conversation_create_idempotency: 'external_id_v1', filters: { external_id: 'chat-1' } },
    })
    mocks.createTask.mockResolvedValue({ data: { external_id: 'task-1' } })
    mocks.listTasks.mockResolvedValue({ data: [{ external_id: 'task-1' }] })
    mocks.verifyTaskCreate.mockResolvedValue({
      data: { external_id: 'task-1', exists: true },
      meta: { task_create_idempotency: 'external_id_v1', filters: { external_id: 'task-1' } },
    })
    mocks.updateTask.mockResolvedValue({ data: {} })
    mocks.detectAgents.mockResolvedValue([{ name: 'codex', installed: true }])
    mocks.runAgentCli.mockResolvedValue({ ok: true, code: 0, stdout: 'done', stderr: '' })
    mocks.prepareAgentJob.mockResolvedValue({ id: 'managed-job', status: 'awaiting_approval' })
    mocks.writeBridgeFile.mockResolvedValue('E:\\project\\LUCZOR.md')
    mocks.buildBridgeMarkdown.mockReturnValue('# Bridge')
    mocks.getProjectWorkspace.mockResolvedValue({
      projectId: 'project-1',
      rootPath: 'E:\\project',
      displayName: 'project',
      isGitRepository: true,
      status: 'ready',
      updatedAt: 10,
    })
    mocks.requireProjectWorkspace.mockResolvedValue({
      projectId: 'project-1',
      rootPath: 'E:\\project',
      displayName: 'project',
      isGitRepository: true,
      status: 'ready',
      updatedAt: 10,
    })
    mocks.agentProjectSnapshot.mockResolvedValue({
      principalId: 'device:v1:test',
      projectId: 'project-1',
      projectName: 'Projekt 1',
      rootPath: 'E:\\project',
      workspaceUpdatedAt: 10,
    })
    mocks.resolveWorkspacePrincipalId.mockResolvedValue('device:v1:test')
    mocks.getRepositoryExternalPolicy.mockResolvedValue('allow_selected')
    mocks.state.projects = [{ id: 'project-1', name: 'Projekt 1', summary: 'Stand', goals: [] }]

    const plan = {
      steps: [
        { title: 'Erster Schritt', status: 'done' },
        { title: 'Zweiter Schritt', status: 'in_progress' },
      ],
      note: 'Weiter',
    }
    mocks.setPlan.mockReturnValue({ plan, repairs: [] })
    mocks.getPlan.mockReturnValue(plan)
    mocks.planProgress.mockReturnValue({ done: 1, total: 2 })
    mocks.currentPlanStep.mockReturnValue(plan.steps[1])
  })

  it('preserves the complete ordered tool set and approval metadata', () => {
    const contract = listTools().map(tool => ({
      name: tool.name,
      category: tool.category,
      mutating: tool.mutating,
      requiresApproval: tool.requiresApproval,
    }))

    expect(contract).toEqual(TOOL_CONTRACT)
    expect(new Set(contract.map(tool => tool.name))).toHaveLength(TOOL_CONTRACT.length)
    expect(toOpenAITools().map(tool => tool.function.name)).toEqual(TOOL_CONTRACT.map(tool => tool.name))
    expect(getTool('missing_tool')).toBeUndefined()
  })

  it('preserves every model-facing description and parameter schema', () => {
    const fingerprint = createHash('sha256').update(JSON.stringify(toOpenAITools())).digest('hex')

    expect(fingerprint).toBe(TOOL_SCHEMA_SHA256)
    for (const tool of toOpenAITools().filter(
      item => !['local_model_status', 'model_capabilities'].includes(item.function.name)
    )) {
      const parameters = tool.function.parameters as { properties?: Record<string, unknown> }
      expect(Object.keys(parameters.properties ?? {})).not.toHaveLength(0)
    }
    expect(getTool('local_model_status')!.parameters).toMatchObject({ properties: {}, additionalProperties: false })
  })

  it('keeps the original project/desktop tools unchanged while adding six guarded workspace tools', () => {
    const coreTools = toOpenAITools().filter(
      tool =>
        !getTool(tool.function.name)?.workspaceOnly &&
        tool.function.name !== 'local_model_status' &&
        !tool.function.name.startsWith('workflow_')
    )
    expect(createHash('sha256').update(JSON.stringify(coreTools)).digest('hex')).toBe(CORE_TOOL_SCHEMA_SHA256)
    const workspaceTools = listTools().filter(tool => tool.workspaceOnly)
    expect(workspaceTools.map(tool => tool.name)).toEqual([
      'workspace_overview',
      'workspace_project_update',
      'workspace_chat_read',
      'workspace_agent_prepare',
      'workspace_agent_status',
      'workspace_agent_cancel',
    ])
    for (const tool of workspaceTools) {
      expect(tool).toMatchObject({ workspaceOnly: true, dataHandling: 'ephemeral', scope: 'app' })
      const schema = tool.parameters as { properties: Record<string, unknown>; required: string[] }
      expect(schema.properties).not.toHaveProperty('workspaceScope')
      expect(schema.properties).not.toHaveProperty('principalId')
    }
    for (const tool of workspaceTools.filter(tool => tool.name !== 'workspace_overview'))
      expect(tool.parameters.required).toContain('project_id')
    for (const suffix of ['prepare', 'status', 'cancel']) {
      const source = getTool(`agent_job_${suffix}`)!
      const scoped = getTool(`workspace_agent_${suffix}`)!
      expect(scoped).toMatchObject({
        mutating: source.mutating,
        requiresApproval: source.requiresApproval,
        risk: source.risk,
        effects: source.effects,
      })
      expect(scoped.parameters).toMatchObject({
        additionalProperties: false,
        properties: source.parameters.properties,
        required: [...(source.parameters.required as string[]), 'project_id'],
      })
    }
  })

  it('returns a defensive registry array without changing lookups', () => {
    const listed = listTools()
    listed.pop()

    expect(listTools()).toHaveLength(TOOL_CONTRACT.length)
    expect(getTool('plan_get')?.name).toBe('plan_get')
  })

  it('routes local project reads and mutations to the state store', async () => {
    const stateResult = await getTool('project_get_state')!.execute({}, PROJECT_CONTEXT)
    await getTool('project_set_summary')!.execute({ summary: '  Neuer Stand  ' }, PROJECT_CONTEXT)
    const goalResult = (await getTool('project_upsert_goal')!.execute(
      { title: 'Luczor optimieren', status: 'open' },
      PROJECT_CONTEXT
    )) as { goal: { id: string } }

    expect(stateResult).toEqual({
      id: 'project-1',
      name: 'Projekt 1',
      summary: 'Stand',
      goals: [],
      workspace: {
        bound: true,
        status: 'ready',
        display_name: 'project',
        is_git_repository: true,
        alias: '@project',
      },
    })
    expect(mocks.setProjectSummary).toHaveBeenCalledWith('project-1', 'Neuer Stand')
    expect(goalResult.goal.id).not.toBe('')
    expect(mocks.upsertGoal.mock.calls[0]![1].id).toBe(goalResult.goal.id)
  })

  it('routes project, chat and task creation through the established API methods', async () => {
    await getTool('project_create')!.execute({ name: '  Neues Projekt  ' }, PROJECT_CONTEXT)
    await getTool('chat_create')!.execute({}, PROJECT_CONTEXT)
    await getTool('task_create')!.execute({ title: 'Tests schreiben' }, PROJECT_CONTEXT)

    const projectId = mocks.addProject.mock.calls[0]![0].id as string
    expect(mocks.enqueueProjectSync).toHaveBeenCalledWith(projectId, 'Neues Projekt', mocks.apiConfig)
    expect(mocks.commitProjectSync).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'operation' }),
      expect.any(Function)
    )
    expect(mocks.addProject).toHaveBeenCalledWith({ id: projectId, name: 'Neues Projekt' }, false)
    expect(mocks.saveAppStateStrict).toHaveBeenCalledWith(mocks.state)
    expect(mocks.flushProjectSyncQueue).toHaveBeenCalledWith({ config: mocks.apiConfig, signal: undefined })
    expect(mocks.createProject).toHaveBeenCalledWith('project-1', 'Projekt 1', undefined, mocks.apiConfig)
    expect(mocks.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        external_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        project_id: 'project-1',
      }),
      undefined,
      mocks.apiConfig
    )
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Tests schreiben',
        project_id: 'project-1',
      }),
      undefined,
      mocks.apiConfig
    )
  })

  it('returns an actionable uncertain chat result and supports exact write-only verification', async () => {
    mocks.createConversation.mockRejectedValueOnce(Object.assign(new Error('Verbindung unterbrochen.'), { status: 0 }))

    const uncertain = (await getTool('chat_create')!.execute({ title: 'Projektanalyse' }, PROJECT_CONTEXT)) as {
      match_conversation_id: string
    }
    const externalId = uncertain.match_conversation_id

    expect(uncertain).toMatchObject({
      ok: false,
      code: 'conversation_create_outcome_unknown',
      retry: 'verify_before_retry',
      next_tool: 'chat_list',
      next_arguments: { project_id: 'project-1', external_id: externalId },
    })
    expect(externalId).toMatch(/^[0-9a-f-]{36}$/u)

    mocks.listConversations.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }))
    mocks.verifyConversationCreate.mockResolvedValueOnce({
      data: { external_id: externalId, exists: false },
      meta: { conversation_create_idempotency: 'external_id_v1', filters: { external_id: externalId } },
    })
    await expect(
      getTool('chat_list')!.execute({ project_id: 'project-1', external_id: externalId }, PROJECT_CONTEXT)
    ).resolves.toEqual({
      ok: true,
      conversations: [],
      conversation_create_idempotency: 'external_id_v1',
      filtered_external_id: externalId,
    })
    expect(mocks.verifyConversationCreate).toHaveBeenCalledWith(externalId, 'project-1', undefined, mocks.apiConfig)
  })

  it('finishes local project creation without waiting for server synchronization', async () => {
    mocks.flushProjectSyncQueue.mockImplementationOnce(() => new Promise(() => {}))

    await expect(
      getTool('project_create')!.execute({ name: 'Offline Projekt' }, PROJECT_CONTEXT)
    ).resolves.toMatchObject({
      ok: true,
      name: 'Offline Projekt',
      synced: false,
      sync_queued: true,
    })
    expect(mocks.addProject).toHaveBeenCalledWith({ id: expect.any(String), name: 'Offline Projekt' }, false)
  })

  it('persists the project retry before exposing the local project', async () => {
    let release!: () => void
    mocks.enqueueProjectSync.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )

    const creation = getTool('project_create')!.execute({ name: 'Durables Projekt' }, PROJECT_CONTEXT)
    await Promise.resolve()

    expect(mocks.addProject).not.toHaveBeenCalled()
    release()
    await expect(creation).resolves.toMatchObject({ ok: true, sync_queued: true })
    expect(mocks.enqueueProjectSync).toHaveBeenCalledOnce()
    expect(mocks.addProject).toHaveBeenCalledOnce()
  })

  it('does not report or synchronize project creation when strict local persistence fails', async () => {
    mocks.saveAppStateStrict.mockRejectedValueOnce(new Error('disk full'))

    await expect(getTool('project_create')!.execute({ name: 'Nicht durabel' }, PROJECT_CONTEXT)).rejects.toThrow(
      'disk full'
    )

    expect(mocks.addProject).toHaveBeenCalledOnce()
    expect(mocks.rollbackProjectCreation).toHaveBeenCalledOnce()
    expect(mocks.flushProjectSyncQueue).not.toHaveBeenCalled()
  })

  it('does not publish or synchronize a project when execution changes during queue persistence', async () => {
    let release!: () => void
    mocks.enqueueProjectSync.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () => resolve({ scopeId: 'scope', operationId: 'revoked', externalId: 'project' })
        })
    )
    const ticket = executionGate.capture()
    const creation = getTool('project_create')!.execute(
      { name: 'Widerrufenes Projekt' },
      { ...PROJECT_CONTEXT, execution: ticket }
    )
    await vi.waitFor(() => expect(mocks.enqueueProjectSync).toHaveBeenCalledOnce())
    updateExecutionControls({ mode: 'act', killSwitch: true, scope: 'project-1' })
    release()

    await expect(creation).rejects.toThrow('Ausführung verworfen')
    expect(mocks.addProject).not.toHaveBeenCalled()
    expect(mocks.flushProjectSyncQueue).not.toHaveBeenCalled()
  })

  it('keeps explicit current-project alignment for task and chat creation', async () => {
    await getTool('task_create')!.execute({ title: 'Tests', project_id: 'project-1' }, PROJECT_CONTEXT)
    await getTool('chat_create')!.execute({ project_id: 'project-1' }, PROJECT_CONTEXT)

    expect(mocks.createProject).toHaveBeenCalledTimes(2)
    expect(mocks.createProject).toHaveBeenNthCalledWith(1, 'project-1', 'Projekt 1', undefined, mocks.apiConfig)
    expect(mocks.createProject).toHaveBeenNthCalledWith(2, 'project-1', 'Projekt 1', undefined, mocks.apiConfig)
  })

  it('returns an actionable task-create rejection and permits a corrected retry', async () => {
    mocks.createTask.mockRejectedValueOnce(Object.assign(new Error('Titel ist zu lang.'), { status: 422 }))

    const rejected = await getTool('task_create')!.execute({ title: 'Ungültiger Titel' }, PROJECT_CONTEXT)
    const retried = await getTool('task_create')!.execute({ title: 'Korrigierter Titel' }, PROJECT_CONTEXT)

    expect(rejected).toEqual({
      ok: false,
      code: 'task_create_rejected',
      error: 'task_create wurde vom Server abgelehnt (HTTP 422): Titel ist zu lang.',
      retry: 'fix_arguments',
    })
    expect(retried).toEqual({ ok: true, task_id: 'task-1' })
    expect(mocks.createTask).toHaveBeenCalledTimes(2)
  })

  it('requires verification before retrying a task whose POST outcome is uncertain', async () => {
    mocks.createTask.mockRejectedValueOnce(Object.assign(new Error('Verbindung unterbrochen.'), { status: 0 }))

    const result = await getTool('task_create')!.execute({ title: 'Graph vervollständigen' }, PROJECT_CONTEXT)
    const matchTaskId = (result as { match_task_id: string }).match_task_id

    expect(result).toEqual({
      ok: false,
      code: 'task_create_outcome_unknown',
      error: expect.stringContaining('Wiederhole task_create nicht sofort'),
      retry: 'verify_before_retry',
      next_tool: 'task_list',
      next_arguments: { project_id: 'project-1', external_id: matchTaskId },
      match_title: 'Graph vervollständigen',
      match_task_id: matchTaskId,
    })
    expect(matchTaskId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: matchTaskId }),
      undefined,
      mocks.apiConfig
    )
  })

  it('treats HTTP 408 after a task POST as an uncertain outcome', async () => {
    mocks.createTask.mockRejectedValueOnce(Object.assign(new Error('Gateway timeout.'), { status: 408 }))

    const result = await getTool('task_create')!.execute({ title: 'Timeout prüfen' }, PROJECT_CONTEXT)

    expect(result).toMatchObject({
      ok: false,
      code: 'task_create_outcome_unknown',
      retry: 'verify_before_retry',
      next_tool: 'task_list',
      next_arguments: { project_id: 'project-1', external_id: expect.any(String) },
    })
  })

  it('reuses a guarded task operation id supplied by the agent runtime', async () => {
    const externalId = '29ee4734-99c0-4f4c-8f06-33df65bce0d5'

    const result = await getTool('task_create')!.execute(
      { title: 'Release prüfen', external_id: externalId },
      PROJECT_CONTEXT
    )

    expect(result).toEqual({ ok: true, task_id: 'task-1' })
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: externalId }),
      undefined,
      mocks.apiConfig
    )
  })

  it('does not post a task with a corrupt internal operation id', async () => {
    const result = await getTool('task_create')!.execute(
      { title: 'Release prüfen', external_id: 'invalid-id' },
      PROJECT_CONTEXT
    )

    expect(result).toEqual({
      ok: false,
      code: 'task_create_rejected',
      error: 'Die interne task_create-Operations-ID ist ungültig; der Task-POST wurde nicht gesendet.',
      retry: 'stop',
    })
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it('states that no task POST ran when current-project preparation fails', async () => {
    mocks.createProject.mockRejectedValueOnce(new Error('Projektserver nicht erreichbar.'))

    const result = await getTool('task_create')!.execute({ title: 'Später erneut versuchen' }, PROJECT_CONTEXT)

    expect(result).toEqual({
      ok: false,
      code: 'task_create_project_prepare_failed',
      error: expect.stringContaining('Es wurde noch kein Task-POST gesendet.'),
      retry: 'retry_same_call',
    })
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it('rejects a task create outside the active project before any POST', async () => {
    const result = await getTool('task_create')!.execute(
      { title: 'Falsches Projekt', project_id: 'project-2' },
      PROJECT_CONTEXT
    )

    expect(result).toMatchObject({ ok: false, code: 'task_create_project_scope_rejected' })
    expect(mocks.createTask).not.toHaveBeenCalled()
  })

  it('routes task listing, updates and completion without changing payloads', async () => {
    await getTool('task_list')!.execute(
      { status: 'open', project_id: 'project-1', conversation_id: 'chat-1' },
      PROJECT_CONTEXT
    )
    await getTool('task_update')!.execute(
      {
        task_id: 'task-1',
        status: 'in_progress',
        priority: 'high',
        title: 'Titel',
        description: 'Details',
        project_id: 'project-2',
        conversation_id: 'chat-2',
      },
      PROJECT_CONTEXT
    )
    await getTool('task_complete')!.execute({ task_id: 'task-1' }, PROJECT_CONTEXT)

    expect(mocks.listTasks).toHaveBeenCalledWith(
      {
        status: 'open',
        project_id: 'project-1',
        conversation_id: 'chat-1',
        external_id: undefined,
      },
      undefined,
      mocks.apiConfig
    )
    expect(mocks.updateTask).toHaveBeenNthCalledWith(
      1,
      'task-1',
      {
        status: 'in_progress',
        priority: 'high',
        title: 'Titel',
        description: 'Details',
        project_id: 'project-2',
        conversation_id: 'chat-2',
      },
      undefined,
      mocks.apiConfig
    )
    expect(mocks.updateTask).toHaveBeenNthCalledWith(2, 'task-1', { status: 'done' }, undefined, mocks.apiConfig)
  })

  it('uses the write-scoped exact recovery endpoint when task listing is forbidden', async () => {
    const forbidden = Object.assign(new Error('Forbidden'), { status: 403 })
    mocks.listTasks.mockRejectedValueOnce(forbidden)
    mocks.verifyTaskCreate.mockResolvedValueOnce({
      data: { external_id: 'task-recovery', exists: false },
      meta: {
        task_create_idempotency: 'external_id_v1',
        filters: { external_id: 'task-recovery' },
      },
    })

    const result = await getTool('task_list')!.execute({ external_id: 'task-recovery' }, PROJECT_CONTEXT)

    expect(mocks.verifyTaskCreate).toHaveBeenCalledWith('task-recovery', 'project-1', undefined, mocks.apiConfig)
    expect(result).toEqual({
      ok: true,
      tasks: [],
      task_create_idempotency: 'external_id_v1',
      filtered_external_id: 'task-recovery',
    })
  })

  it('does not cross to task-create recovery after the captured execution is aborted', async () => {
    const controller = new AbortController()
    mocks.listTasks.mockImplementationOnce(async () => {
      controller.abort()
      throw Object.assign(new Error('Forbidden'), { status: 403 })
    })

    await expect(
      getTool('task_list')!.execute(
        { project_id: 'project-1', external_id: 'task-recovery' },
        { ...PROJECT_CONTEXT, signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.verifyTaskCreate).not.toHaveBeenCalled()
  })

  it.each([
    ['os_move_mouse', { x: 10.4, y: 20.6 }, 'move_mouse', { payload: { x: 10, y: 21 } }],
    [
      'os_click',
      { button: 'right', x: 3.4, y: 7.6, double: true },
      'mouse_click',
      { payload: { button: 'right', x: 3, y: 8, double: true } },
    ],
    ['os_type_text', { text: 'Hallo' }, 'type_text', { payload: { text: 'Hallo' } }],
    ['os_press_key', { key: 'enter' }, 'press_key', { payload: { key: 'enter' } }],
    ['os_scroll', { amount: -4, axis: 'vertical' }, 'scroll', { payload: { amount: -4, axis: 'vertical' } }],
    [
      'os_hotkey',
      { modifiers: ['control', 'shift'], key: 's' },
      'hotkey',
      { payload: { modifiers: ['control', 'shift'], key: 's' } },
    ],
    ['os_open_url', { url: 'https://example.test' }, 'open_url', { payload: { url: 'https://example.test' } }],
  ])('routes %s to the original Tauri command', async (toolName, args, command, payload) => {
    mocks.invoke.mockResolvedValue(undefined)
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'project-1' })
    await executionPayload()
    await getTool(toolName)!.execute({ ...args, observation_id: 'observed-window' }, PROJECT_CONTEXT)

    expect(mocks.invoke).toHaveBeenCalledWith(command, {
      payload: {
        ...payload.payload,
        ...(command === 'open_url' ? {} : { observationId: 'observed-window' }),
        execution: { sessionId: executionGate.sessionId, generation: executionGate.snapshot().generation },
      },
    })
  })

  it('routes OS perception tools and keeps screenshot publication compatible', async () => {
    mocks.invoke.mockImplementation(async command => {
      if (command === 'read_clipboard') return 'abcdef'
      if (command === 'list_windows')
        return [
          { title: 'Editor', focused: true },
          { title: 'Browser', focused: false },
        ]
      if (command === 'capture_screen') return { base64: 'aW1hZ2U=', mime: 'image/png', width: 640, height: 480 }
      if (command === 'system_metrics') return { cpu: 4 }
      return null
    })

    expect(await getTool('os_read_clipboard')!.execute({ max_chars: 3 }, PROJECT_CONTEXT)).toEqual({
      text: 'abc…',
      length: 6,
    })
    expect(await getTool('os_list_windows')!.execute({ focused_only: true }, PROJECT_CONTEXT)).toEqual({
      windows: [{ title: 'Editor', focused: true }],
    })
    expect(await getTool('os_screen_capture')!.execute({}, PROJECT_CONTEXT)).toEqual({
      captured: true,
      width: 640,
      height: 480,
    })
    expect(lastScreenshot.value).toBe('data:image/png;base64,aW1hZ2U=')

    const environment = (await getTool('os_environment')!.execute({}, PROJECT_CONTEXT)) as {
      screenshot: boolean
      windows: unknown[]
      metrics: unknown
    }
    expect(environment).toMatchObject({
      screenshot: false,
      windows: [
        { title: 'Editor', focused: true },
        { title: 'Browser', focused: false },
      ],
      metrics: { cpu: 4 },
    })
  })

  it('routes coding-agent tools to detection, dispatch and bridge handlers', async () => {
    await getTool('agent_detect')!.execute({}, PROJECT_CONTEXT)
    await getTool('agent_dispatch')!.execute({ agent: 'codex', prompt: '  Prüfen  ' }, PROJECT_CONTEXT)
    await getTool('agent_bridge_write')!.execute({ content: '# Explicit' }, PROJECT_CONTEXT)

    expect(mocks.detectAgents).toHaveBeenCalledOnce()
    expect(mocks.prepareAgentJob).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', prompt: 'Prüfen', permission: 'read-only' })
    )
    expect(mocks.runAgentCli).not.toHaveBeenCalled()
    expect(mocks.requireProjectWorkspace).toHaveBeenCalledWith('project-1', 'device:v1:test')
    expect(mocks.writeBridgeFile).toHaveBeenCalledWith(
      {
        principalId: 'device:v1:test',
        projectId: 'project-1',
        expectedRootPath: 'E:\\project',
        expectedWorkspaceUpdatedAt: 10,
      },
      '# Explicit',
      expect.objectContaining({ sessionId: expect.any(String), generation: expect.any(Number) })
    )
  })

  it('routes plan updates and reads through the visible-plan service', async () => {
    const steps = [{ title: 'Erster Schritt', status: 'in_progress' }]
    await getTool('plan_update')!.execute({ steps, note: 'Start' }, PROJECT_CONTEXT)
    const result = await getTool('plan_get')!.execute({ include_done: false }, PROJECT_CONTEXT)

    expect(mocks.assertPlanPrincipal).toHaveBeenCalledWith('device:v1:test')
    expect(mocks.setPlan).toHaveBeenCalledWith('project-1', steps, 'Start', 'device:v1:test')
    expect(mocks.getPlan).toHaveBeenCalledWith('project-1', 'device:v1:test')
    expect(result).toEqual({
      ok: true,
      steps: [{ title: 'Zweiter Schritt', status: 'in_progress' }],
      note: 'Weiter',
      progress: '1/2',
      current_step: 'Zweiter Schritt',
    })
  })
})
