import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/* Public tool arguments intentionally use x/y coordinate names. */
/* eslint id-length: ['error', { exceptions: ['x', 'y'] }] */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  setProjectSummary: vi.fn(),
  upsertGoal: vi.fn(),
  addProject: vi.fn(),
  createProject: vi.fn(),
  createConversation: vi.fn(),
  createTask: vi.fn(),
  listTasks: vi.fn(),
  updateTask: vi.fn(),
  detectAgents: vi.fn(),
  runAgentCli: vi.fn(),
  writeBridgeFile: vi.fn(),
  buildBridgeMarkdown: vi.fn(),
  setPlan: vi.fn(),
  getPlan: vi.fn(),
  planProgress: vi.fn(),
  currentPlanStep: vi.fn(),
  getProjectWorkspace: vi.fn(),
  requireProjectWorkspace: vi.fn(),
  resolveWorkspacePrincipalId: vi.fn(),
  getRepositoryExternalPolicy: vi.fn(),
  state: { projects: [] as unknown[] },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@/state/store', () => ({
  state: mocks.state,
  mutations: {
    upsertGoal: mocks.upsertGoal,
    setProjectSummary: mocks.setProjectSummary,
    addProject: mocks.addProject,
  },
}))
vi.mock('@/services/api/luczorApi', () => ({
  LuczorApi: {
    createProject: mocks.createProject,
    createConversation: mocks.createConversation,
    createTask: mocks.createTask,
    listTasks: mocks.listTasks,
    updateTask: mocks.updateTask,
  },
}))
vi.mock('@/services/agents', () => ({
  detectAgents: mocks.detectAgents,
  runAgentCli: mocks.runAgentCli,
  writeBridgeFile: mocks.writeBridgeFile,
  buildBridgeMarkdown: mocks.buildBridgeMarkdown,
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
  setPlan: mocks.setPlan,
  getPlan: mocks.getPlan,
  planProgress: mocks.planProgress,
  currentPlanStep: mocks.currentPlanStep,
}))

import { getTool, lastScreenshot, listTools, toOpenAITools } from '@/services/tools/registry'

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
  { name: 'project_create', category: 'project', mutating: true, requiresApproval: true },
  { name: 'chat_create', category: 'app', mutating: true, requiresApproval: true },
  { name: 'task_create', category: 'app', mutating: true, requiresApproval: true },
  { name: 'task_list', category: 'app', mutating: false, requiresApproval: false },
  { name: 'task_update', category: 'app', mutating: true, requiresApproval: true },
  { name: 'task_complete', category: 'app', mutating: true, requiresApproval: true },
  { name: 'agent_detect', category: 'app', mutating: false, requiresApproval: false },
  { name: 'agent_dispatch', category: 'app', mutating: true, requiresApproval: true },
  { name: 'agent_bridge_write', category: 'app', mutating: true, requiresApproval: true },
  { name: 'plan_update', category: 'app', mutating: false, requiresApproval: false },
  { name: 'plan_get', category: 'app', mutating: false, requiresApproval: false },
] as const

const TOOL_SCHEMA_SHA256 = '73df93e0d2b07084741f540c6218bbd0ff5a578cc061984a2a996a670b202954'
const PROJECT_CONTEXT = { projectId: 'project-1' }

describe('tool registry contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastScreenshot.value = null
    mocks.createProject.mockResolvedValue({ data: {} })
    mocks.createConversation.mockResolvedValue({ data: { external_id: 'chat-1' } })
    mocks.createTask.mockResolvedValue({ data: { external_id: 'task-1' } })
    mocks.listTasks.mockResolvedValue({ data: [{ external_id: 'task-1' }] })
    mocks.updateTask.mockResolvedValue({ data: {} })
    mocks.detectAgents.mockResolvedValue([{ name: 'codex', installed: true }])
    mocks.runAgentCli.mockResolvedValue({ ok: true, code: 0, stdout: 'done', stderr: '' })
    mocks.writeBridgeFile.mockResolvedValue('E:\\project\\LUCZOR.md')
    mocks.buildBridgeMarkdown.mockReturnValue('# Bridge')
    mocks.getProjectWorkspace.mockResolvedValue({
      projectId: 'project-1',
      rootPath: 'E:\\project',
      displayName: 'project',
      isGitRepository: true,
      status: 'ready',
    })
    mocks.requireProjectWorkspace.mockResolvedValue({
      projectId: 'project-1',
      rootPath: 'E:\\project',
      displayName: 'project',
      isGitRepository: true,
      status: 'ready',
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
    for (const tool of toOpenAITools()) {
      const parameters = tool.function.parameters as { properties?: Record<string, unknown> }
      expect(Object.keys(parameters.properties ?? {})).not.toHaveLength(0)
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

    expect(mocks.createProject).toHaveBeenCalledWith(expect.any(String), 'Neues Projekt')
    expect(mocks.addProject).toHaveBeenCalledWith({ id: expect.any(String), name: 'Neues Projekt' })
    expect(mocks.createProject).toHaveBeenCalledWith('project-1', 'Projekt 1')
    expect(mocks.createConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'project-1',
      })
    )
    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Tests schreiben',
        project_id: 'project-1',
      })
    )
  })

  it('keeps explicit current-project alignment for task and chat creation', async () => {
    await getTool('task_create')!.execute({ title: 'Tests', project_id: 'project-1' }, PROJECT_CONTEXT)
    await getTool('chat_create')!.execute({ project_id: 'project-1' }, PROJECT_CONTEXT)

    expect(mocks.createProject).toHaveBeenCalledTimes(2)
    expect(mocks.createProject).toHaveBeenNthCalledWith(1, 'project-1', 'Projekt 1')
    expect(mocks.createProject).toHaveBeenNthCalledWith(2, 'project-1', 'Projekt 1')
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

    expect(mocks.listTasks).toHaveBeenCalledWith({
      status: 'open',
      project_id: 'project-1',
      conversation_id: 'chat-1',
    })
    expect(mocks.updateTask).toHaveBeenNthCalledWith(1, 'task-1', {
      status: 'in_progress',
      priority: 'high',
      title: 'Titel',
      description: 'Details',
      project_id: 'project-2',
      conversation_id: 'chat-2',
    })
    expect(mocks.updateTask).toHaveBeenNthCalledWith(2, 'task-1', { status: 'done' })
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
    await getTool(toolName)!.execute(args, PROJECT_CONTEXT)

    expect(mocks.invoke).toHaveBeenCalledWith(command, payload)
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
    expect(mocks.requireProjectWorkspace).toHaveBeenCalledWith('project-1')
    expect(mocks.runAgentCli).toHaveBeenCalledWith('codex', 'Prüfen', 'E:\\project')
    expect(mocks.writeBridgeFile).toHaveBeenCalledWith('E:\\project', '# Explicit')
  })

  it('routes plan updates and reads through the visible-plan service', async () => {
    const steps = [{ title: 'Erster Schritt', status: 'in_progress' }]
    await getTool('plan_update')!.execute({ steps, note: 'Start' }, PROJECT_CONTEXT)
    const result = await getTool('plan_get')!.execute({ include_done: false }, PROJECT_CONTEXT)

    expect(mocks.setPlan).toHaveBeenCalledWith('project-1', steps, 'Start')
    expect(mocks.getPlan).toHaveBeenCalledWith('project-1')
    expect(result).toEqual({
      ok: true,
      steps: [{ title: 'Zweiter Schritt', status: 'in_progress' }],
      note: 'Weiter',
      progress: '1/2',
      current_step: 'Zweiter Schritt',
    })
  })
})
