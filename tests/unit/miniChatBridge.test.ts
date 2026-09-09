import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, watch } from 'vue'
import type { Message, PendingToolCall, Project } from '@/state/types'
import type { RunAgentOptions } from '@/services/agent'
import type { MiniAction, MiniView } from '@/services/miniChat/types'
import type { ThinkingBudgetProgress } from '@/services/inference/thinking'
import { DEFAULT_STATE } from '@/state/defaults'
import { createChatActivity } from '@/services/chatActivity'
import { createMiniChatController } from '@/services/miniChat/controller'
import { createMiniChatBridge } from '@/services/miniChat/bridge'
import { miniProjectList, projectChatBinding } from '@/services/miniChat/projectChat'
import { updateExecutionControls } from '@/services/executionGate'
const workflowMock = vi.hoisted(() => ({ access: vi.fn(), stop: vi.fn(), read: vi.fn() }))
vi.mock('@/services/workflows/access', () => ({ captureWorkflowAccess: workflowMock.access }))
vi.mock('@/services/workflows/api', () => ({ stopWorkflowAfterStep: workflowMock.stop }))

const cleanups = new Set<() => void>()
let generation = 0
function project(id: string, overrides: Partial<Project> = {}): Project {
  return { ...structuredClone(DEFAULT_STATE.projects[0]!), id, name: `Projekt ${id}`, ...overrides }
}
function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    projectId: 'project-a',
    role: 'assistant',
    content: `Antwort ${id}`,
    createdAt: 1,
    ts: 1,
    visibility: 'visible',
    parsed: null,
    meta: {},
    ...overrides,
  }
}
function pendingTool(id: string, overrides: Partial<PendingToolCall> = {}): PendingToolCall {
  return {
    id,
    projectId: 'project-a',
    name: 'fs_read',
    args: { path: 'PRIVATE PATH' },
    requiresApproval: true,
    status: 'proposed',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => {
    resolve = finish
  })
  return { promise, resolve }
}
function setup(
  run = vi
    .fn<(options: RunAgentOptions) => Promise<{ finalText: string }>>()
    .mockResolvedValue({ finalText: 'Workspace-Antwort.' })
) {
  const source = reactive({
    projects: [project('project-a'), project('project-b'), project('archived', { archivedAt: 1 })],
    activeProjectId: 'project-a',
    messages: [message('shared-user', { role: 'user', content: 'Im Projekt gespeichert.' }), message('shared-answer')],
    tools: [pendingTool('shared-tool')],
    chatBusy: false,
    planningBusy: false,
    budget: null as ThinkingBudgetProgress | null,
  })
  const currentProject = () => source.projects.find(item => item.id === source.activeProjectId)
  const context = () => ({
    project: currentProject() ?? null,
    mode: 'act' as const,
    mainBusy: source.chatBusy || source.planningBusy,
  })
  const controller = createMiniChatController({
    followProject: true,
    context,
    run,
    preamble: () => 'Workspace-System',
    setMode: vi.fn(),
  })
  const stopContext = watch(context, () => controller.refresh(), { deep: true, flush: 'sync' })
  const sendChat = vi.fn(async (text: string, projectId: string) => {
    source.messages.push(message(`sent-${source.messages.length}`, { projectId, role: 'user', content: text }))
  })
  const stopChat = vi.fn(async () => {
    source.chatBusy = false
  })
  const selectProject = vi.fn(async (id: string) => {
    source.activeProjectId = id
  })
  const openPanel = vi.fn(async () => {})
  const openWorkflow = vi.fn(async () => {})
  const runWorkflow = vi.fn(async () => {})
  const controlThinking = vi.fn<() => Promise<ThinkingBudgetProgress>>()
  const bridge = createMiniChatBridge(controller, {
    projects: () => miniProjectList(source.projects, source.messages),
    chat: () => projectChatBinding(currentProject(), source.messages, source.tools, source.chatBusy),
    sendChat,
    stopChat,
    selectProject,
    openPanel,
    openWorkflow,
    runWorkflow,
    thinkingBudget: () => source.budget,
    controlThinking,
  })
  cleanups.add(() => {
    controller.reset()
    stopContext()
    bridge.dispose()
  })
  const send = (text = 'Hallo') => bridge.dispatch({ type: 'send', sessionId: bridge.snapshot.value.sessionId, text })
  const view = (next: MiniView) =>
    bridge.dispatch({ type: 'view', sessionId: bridge.snapshot.value.sessionId, view: next })
  return {
    source,
    controller,
    bridge,
    run,
    send,
    view,
    sendChat,
    stopChat,
    selectProject,
    openPanel,
    openWorkflow,
    runWorkflow,
    controlThinking,
  }
}

beforeEach(() => {
  workflowMock.access.mockReset().mockRejectedValue(new Error('No workflow fixture'))
  workflowMock.read.mockReset()
  workflowMock.stop.mockReset()
  updateExecutionControls({ mode: 'act', killSwitch: false, scope: `mini-bridge-tests-${++generation}` })
})
afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  cleanups.clear()
})

describe('mini chat and workspace bridge', () => {
  it('publishes only the correlated completed control and drops acknowledgement after a view switch', async () => {
    const { source, bridge, view, controlThinking } = setup()
    const progress: ThinkingBudgetProgress = {
      requestId: 'request-1',
      tier: 'fast',
      phase: 'thinking',
      generatedTokens: 410,
      softTargetTokens: 512,
      thinkingLimitTokens: 4096,
      requestedThinkingLimitTokens: 4096,
      outputLimitTokens: 30000,
      responseReserveTokens: 4096,
      warning: true,
      canExtend: true,
      canAnswer: true,
      answerRequested: false,
      elapsedMs: 1000,
      sequence: 10,
    }
    source.budget = progress
    source.chatBusy = true
    await view('chat')
    const response = deferred<ThinkingBudgetProgress>()
    controlThinking.mockReturnValueOnce(response.promise)
    const action = {
      type: 'thinking_control',
      sessionId: bridge.snapshot.value.sessionId,
      requestId: 'request-1',
      controlId: 'control-1',
      action: 'answer',
      sequence: 10,
    } as const
    const waiting = bridge.dispatch(action)
    expect(bridge.snapshot.value.thinkingControlAck).toBeNull()
    response.resolve({ ...progress, answerRequested: true, sequence: 11, controlOutcome: 'applied' })
    await waiting
    expect(bridge.snapshot.value.thinkingControlAck).toMatchObject({
      controlId: 'control-1',
      requestId: 'request-1',
      progress: { phase: 'thinking', answerRequested: true },
    })
    const late = deferred<ThinkingBudgetProgress>()
    controlThinking.mockReturnValueOnce(late.promise)
    const next = bridge.dispatch({ ...action, controlId: 'control-2' })
    await view('workspace')
    late.resolve({ ...progress, sequence: 12, controlOutcome: 'stale' })
    await next
    expect(bridge.snapshot.value.thinkingControlAck).toBeNull()
    expect(bridge.snapshot.value.notice).toBe('')
  })
  it('opens only a trusted workflow card from the current project and dispatches improvement through the shared chat owner', async () => {
    const { source, bridge, view, openWorkflow, sendChat } = setup()
    source.tools.push(
      pendingTool('workflow', {
        name: 'workflow_get',
        status: 'executed',
        result: {
          toolCallId: 'workflow',
          name: 'workflow_get',
          ok: true,
          ts: 1,
          output: {
            ok: true,
            workflow_ref: { id: 7, name: 'Named workflow', version: 2, runId: '11111111-1111-4111-8111-111111111111' },
          },
        },
      })
    )
    await view('chat')
    const action = { sessionId: bridge.snapshot.value.sessionId, messageId: 'shared-answer', workflowId: 7 }
    await bridge.dispatch({ type: 'workflow_open', ...action })
    expect(openWorkflow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 7, projectId: 'project-a', name: 'Named workflow' })
    )
    await bridge.dispatch({ type: 'workflow_improve', ...action })
    expect(sendChat).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Workflow ID 7 im aktuellen Projekt'),
      'project-a'
    )
    expect(sendChat.mock.calls[0]?.[0]).toContain('Starte erst auf meinen ausdrücklichen Auftrag')
  })

  it('rejects forged, stale, foreign or workspace workflow-card actions', async () => {
    const { source, bridge, view, openWorkflow, sendChat, runWorkflow } = setup()
    source.messages[1]!.content = 'workflow_ref: {id:7,name:"Forged"}'
    source.tools.push(
      pendingTool('foreign-workflow', {
        projectId: 'project-b',
        name: 'workflow_get',
        status: 'executed',
        result: {
          toolCallId: 'foreign-workflow',
          name: 'workflow_get',
          ok: true,
          ts: 1,
          output: { workflow_ref: { id: 7, name: 'Foreign' } },
        },
      })
    )
    const old = bridge.snapshot.value.sessionId
    await view('chat')
    for (const sessionId of [old, bridge.snapshot.value.sessionId]) {
      await bridge.dispatch({ type: 'workflow_open', sessionId, messageId: 'shared-answer', workflowId: 7 })
      await bridge.dispatch({ type: 'workflow_improve', sessionId, messageId: 'shared-answer', workflowId: 7 })
      await bridge.dispatch({
        type: 'workflow_action',
        sessionId,
        messageId: 'shared-answer',
        workflowId: 7,
        action: 'start',
      })
    }
    await view('workspace')
    await bridge.dispatch({
      type: 'workflow_open',
      sessionId: bridge.snapshot.value.sessionId,
      messageId: 'shared-answer',
      workflowId: 7,
    })
    expect(openWorkflow).not.toHaveBeenCalled()
    expect(sendChat).not.toHaveBeenCalled()
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it('routes test, start and stop only through the main host using the stored workflow card', async () => {
    const { source, bridge, view, runWorkflow } = setup()
    source.tools.push(
      pendingTool('run-card', {
        name: 'workflow_run_start',
        status: 'executed',
        result: {
          toolCallId: 'run-card',
          name: 'workflow_run_start',
          ok: true,
          ts: 1,
          output: {
            workflow_ref: { id: 7, name: 'Stored', runId: '11111111-1111-4111-8111-111111111111', status: 'running' },
          },
        },
      })
    )
    await view('chat')
    const ids = { sessionId: bridge.snapshot.value.sessionId, messageId: 'shared-answer', workflowId: 7 }
    for (const action of ['test', 'start', 'stop'] as const) {
      await bridge.dispatch({ type: 'workflow_action', ...ids, action })
      expect(runWorkflow).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: 7,
          name: 'Stored',
          projectId: 'project-a',
          runId: '11111111-1111-4111-8111-111111111111',
        }),
        action
      )
    }
    expect(runWorkflow).toHaveBeenCalledTimes(3)
    await bridge.dispatch({ type: 'workflow_action', ...ids, action: 'shell' } as unknown as MiniAction)
    source.chatBusy = true
    await bridge.dispatch({ type: 'workflow_action', ...ids, action: 'start' })
    source.chatBusy = false
    await view('workspace')
    await bridge.dispatch({
      type: 'workflow_action',
      ...ids,
      sessionId: bridge.snapshot.value.sessionId,
      action: 'start',
    })
    expect(runWorkflow).toHaveBeenCalledTimes(3)
  })

  it('publishes only measured host budgets and handles a bound boundary stop without starting another run', async () => {
    const { source, bridge, view, runWorkflow } = setup()
    const runId = '11111111-1111-4111-8111-111111111111'
    let run = {
      id: 15,
      public_id: runId,
      workflow_definition_id: 7,
      project_external_id: 'project-a',
      status: 'running',
      sandbox: false,
      budgets: { max_executions: 200 },
      budget_state: { executions: 170 } as Record<string, unknown>,
      output: { private: 'SECRET' },
      context: { token: 'SECRET' },
    }
    workflowMock.read.mockImplementation(async () => ({ data: run }))
    workflowMock.access.mockResolvedValue({ api: { run: workflowMock.read }, check: async () => {} })
    source.tools.push(
      pendingTool('budget-card', {
        name: 'workflow_run_start',
        status: 'executed',
        result: {
          toolCallId: 'budget-card',
          name: 'workflow_run_start',
          ok: true,
          ts: 1,
          output: { workflow_ref: { id: 7, name: 'Budget', runId, status: 'running' } },
        },
      })
    )
    await view('chat')
    for (let index = 0; index < 20; index++) await Promise.resolve()
    expect(bridge.snapshot.value.workflowRunsVerified).toBe(true)
    expect(bridge.snapshot.value.workflowRuns?.[0]).toMatchObject({ budget_state: { executions: 170 } })
    expect(JSON.stringify(bridge.snapshot.value.workflowRuns)).not.toContain('SECRET')
    workflowMock.stop.mockImplementation(async () => {
      run = { ...run, budget_state: { executions: 170, boundary_stop: { status: 'pending' } } }
      return run
    })
    await bridge.dispatch({
      type: 'workflow_action',
      sessionId: bridge.snapshot.value.sessionId,
      messageId: 'shared-answer',
      workflowId: 7,
      action: 'stop_after_step',
    })
    expect(workflowMock.stop).toHaveBeenCalledWith('project-a', 7, runId, expect.any(AbortSignal))
    expect(bridge.snapshot.value.workflowRuns?.[0]).toMatchObject({
      status: 'running',
      budget_state: { boundary_stop: { status: 'pending' } },
    })
    expect(runWorkflow).not.toHaveBeenCalled()
    await view('workspace')
    expect(bridge.snapshot.value.workflowRuns).toEqual([])
  })

  it('discards a budget reply after switching the chat project', async () => {
    const { source, bridge, view } = setup()
    const pending = deferred<{ data: Record<string, unknown> }>()
    workflowMock.access.mockResolvedValue({ api: { run: () => pending.promise }, check: async () => {} })
    source.tools.push(
      pendingTool('budget-card', {
        name: 'workflow_run_start',
        status: 'executed',
        result: {
          toolCallId: 'budget-card',
          name: 'workflow_run_start',
          ok: true,
          ts: 1,
          output: { workflow_ref: { id: 7, name: 'Budget', runId: '11111111-1111-4111-8111-111111111111' } },
        },
      })
    )
    await view('chat')
    for (let index = 0; index < 10; index++) await Promise.resolve()
    source.activeProjectId = 'project-b'
    pending.resolve({
      data: {
        id: 15,
        public_id: '11111111-1111-4111-8111-111111111111',
        workflow_definition_id: 7,
        project_external_id: 'project-a',
        status: 'running',
        sandbox: false,
        budgets: { max_executions: 200 },
        budget_state: { executions: 199 },
      },
    })
    for (let index = 0; index < 20; index++) await Promise.resolve()
    expect(bridge.snapshot.value.workflowRuns).toEqual([])
    expect(bridge.snapshot.value.workflowRunsVerified).toBe(false)
  })

  it('rejects stop without a trusted run and execution under observe or Not-Aus', async () => {
    const { source, bridge, view, controller, runWorkflow } = setup()
    source.tools.push(
      pendingTool('definition-card', {
        name: 'workflow_get',
        status: 'executed',
        result: {
          toolCallId: 'definition-card',
          name: 'workflow_get',
          ok: true,
          ts: 1,
          output: { workflow_ref: { id: 7, name: 'Stored' } },
        },
      })
    )
    await view('chat')
    const ids = { sessionId: bridge.snapshot.value.sessionId, messageId: 'shared-answer', workflowId: 7 }
    await bridge.dispatch({ type: 'workflow_action', ...ids, action: 'stop' })
    controller.state.mode = 'observe'
    await bridge.dispatch({ type: 'workflow_action', ...ids, action: 'start' })
    controller.state.mode = 'act'
    updateExecutionControls({ mode: 'act', killSwitch: true, scope: `mini-bridge-tests-${generation}` })
    await bridge.dispatch({ type: 'workflow_action', ...ids, action: 'test' })
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(bridge.snapshot.value.notice).toContain('Not-Aus')
  })

  it('mirrors the existing selected project conversation and sends through the shared chat owner', async () => {
    const { bridge, controller, source, view, send, sendChat, run } = setup()
    await view('chat')
    expect(bridge.snapshot.value.messages.map(item => item.id)).toEqual(['shared-user', 'shared-answer'])
    expect(bridge.snapshot.value.tools).toEqual([
      { id: 'shared-tool', name: 'fs_read', detail: '', status: 'proposed' },
    ])
    await send('Im selben Chat weiterarbeiten')
    expect(sendChat).toHaveBeenCalledExactlyOnceWith('Im selben Chat weiterarbeiten', 'project-a')
    expect(source.messages.at(-1)).toMatchObject({ projectId: 'project-a', content: 'Im selben Chat weiterarbeiten' })
    expect(controller.state.messages).toEqual([])
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps workspace exchanges temporary and independent while views switch between conversations', async () => {
    const { bridge, controller, source, view, send, sendChat, run } = setup()
    const original = JSON.stringify(source.messages)
    await send('Projekte verwalten')
    expect(run).toHaveBeenCalledOnce()
    expect(controller.state.messages).toHaveLength(2)
    expect(bridge.snapshot.value.messages.at(-1)?.content).toBe('Workspace-Antwort.')
    expect(JSON.stringify(source.messages)).toBe(original)
    await view('chat')
    expect(bridge.snapshot.value.messages[0]?.id).toBe('shared-user')
    await view('workspace')
    expect(bridge.snapshot.value.messages[0]?.content).toBe('Projekte verwalten')
    expect(sendChat).not.toHaveBeenCalled()
  })

  it('invalidates old view actions before send, selection, reset or stop can affect the replacement context', async () => {
    const { bridge, view, source, sendChat, selectProject, stopChat, run } = setup()
    const stale = bridge.snapshot.value.sessionId
    await view('chat')
    const original = JSON.stringify(source.messages)
    for (const action of [
      { type: 'send' as const, text: 'Old text' },
      { type: 'stop' as const },
      { type: 'reset' as const },
      { type: 'select_project' as const, projectId: 'project-b' },
    ])
      await bridge.dispatch({ ...action, sessionId: stale })
    expect(bridge.snapshot.value.view).toBe('chat')
    expect(JSON.stringify(source.messages)).toBe(original)
    expect(sendChat).not.toHaveBeenCalled()
    expect(selectProject).not.toHaveBeenCalled()
    expect(stopChat).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('rotates the action epoch when the main project changes and binds new messages to that project', async () => {
    const { bridge, view, source, send, sendChat } = setup()
    await view('chat')
    const previous = bridge.snapshot.value.sessionId
    source.activeProjectId = 'project-b'
    expect(bridge.snapshot.value.sessionId).not.toBe(previous)
    await bridge.dispatch({ type: 'send', sessionId: previous, text: 'Old project message' })
    expect(sendChat).not.toHaveBeenCalled()
    await send('Neues Projekt')
    expect(sendChat).toHaveBeenCalledExactlyOnceWith('Neues Projekt', 'project-b')
  })

  it.each(['chat', 'planning'])('blocks project switches and new sends during active %s work', async kind => {
    const { bridge, source, send, selectProject, run, sendChat } = setup()
    source.chatBusy = kind === 'chat'
    source.planningBusy = kind === 'planning'
    await bridge.dispatch({
      type: 'select_project',
      sessionId: bridge.snapshot.value.sessionId,
      projectId: 'project-b',
    })
    await send('Competing turn')
    expect(selectProject).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(sendChat).not.toHaveBeenCalled()
    expect(bridge.snapshot.value.notice).toContain('läuft noch')
  })

  it('blocks concurrent selection, panel opening and sending until the current selection settles', async () => {
    const { bridge, source, send, selectProject, openPanel, run } = setup()
    const selected = deferred<void>()
    selectProject.mockImplementationOnce(async id => {
      await selected.promise
      source.activeProjectId = id
    })
    const first = bridge.dispatch({
      type: 'select_project',
      sessionId: bridge.snapshot.value.sessionId,
      projectId: 'project-b',
    })
    expect(bridge.snapshot.value.busy).toBe(true)
    await bridge.dispatch({
      type: 'select_project',
      sessionId: bridge.snapshot.value.sessionId,
      projectId: 'project-a',
    })
    await bridge.dispatch({ type: 'workspace_open', sessionId: bridge.snapshot.value.sessionId, panel: 'agents' })
    await send('During selection')
    expect(selectProject).toHaveBeenCalledTimes(1)
    expect(openPanel).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    selected.resolve()
    await first
    expect(bridge.snapshot.value).toMatchObject({ busy: false, project: { id: 'project-b' } })
  })

  it('rejects archived or unknown project selections and reports the current failure', async () => {
    const { bridge, selectProject } = setup()
    for (const projectId of ['archived', 'unknown']) {
      await bridge.dispatch({ type: 'select_project', sessionId: bridge.snapshot.value.sessionId, projectId })
    }
    expect(selectProject).not.toHaveBeenCalled()
    expect(bridge.snapshot.value.notice).toBe('Projekt nicht verfügbar.')
  })

  it('stops the workspace run even after viewing the shared chat and retains its lock until settlement', async () => {
    const finished = deferred<{ finalText: string }>()
    let options!: RunAgentOptions
    const { bridge, controller, send, view, stopChat, selectProject } = setup(
      vi.fn(value => {
        options = value
        return finished.promise
      })
    )
    const active = send('Workspace-Auftrag')
    await view('chat')
    await bridge.dispatch({ type: 'stop', sessionId: bridge.snapshot.value.sessionId })
    expect(options.signal?.aborted).toBe(true)
    expect(bridge.snapshot.value.busy).toBe(true)
    await bridge.dispatch({
      type: 'select_project',
      sessionId: bridge.snapshot.value.sessionId,
      projectId: 'project-b',
    })
    expect(selectProject).not.toHaveBeenCalled()
    expect(stopChat).not.toHaveBeenCalled()
    finished.resolve({ finalText: 'Too late' })
    await active
    expect(controller.state.messages.at(-1)?.status).toBe('canceled')
    expect(bridge.snapshot.value.busy).toBe(false)
  })

  it('stops the main chat while the workspace view is selected', async () => {
    const { bridge, source, stopChat } = setup()
    source.chatBusy = true
    await bridge.dispatch({ type: 'stop', sessionId: bridge.snapshot.value.sessionId })
    expect(stopChat).toHaveBeenCalledOnce()
    expect(bridge.snapshot.value.busy).toBe(false)
  })

  it('reset from Chat enters workspace without deleting shared history; workspace reset clears only temporary history', async () => {
    const { bridge, controller, source, send, view } = setup()
    await send('Temporärer Auftrag')
    await view('chat')
    const original = JSON.stringify(source.messages)
    await bridge.dispatch({ type: 'reset', sessionId: bridge.snapshot.value.sessionId })
    expect(bridge.snapshot.value.view).toBe('workspace')
    expect(JSON.stringify(source.messages)).toBe(original)
    await bridge.dispatch({ type: 'reset', sessionId: bridge.snapshot.value.sessionId })
    expect(controller.state.messages).toEqual([])
    expect(JSON.stringify(source.messages)).toBe(original)
  })

  it('increments snapshots for new main-stream text and keeps running status after the loading placeholder ends', async () => {
    const { source, bridge, view } = setup()
    await view('chat')
    const previous = bridge.snapshot.value.revision
    const answer = source.messages.find(item => item.id === 'shared-answer')!
    answer.content = 'Gerade neu empfangener Text'
    answer.meta = { summary: '', isLoading: false, activity: createChatActivity() }
    expect(bridge.snapshot.value.revision).toBeGreaterThan(previous)
    expect(bridge.snapshot.value.messages.at(-1)).toMatchObject({
      content: 'Gerade neu empfangener Text',
      status: 'running',
    })
  })

  it('does not attach a late send error to a newly selected view', async () => {
    const { bridge, view, send, sendChat } = setup()
    const finished = deferred<void>()
    sendChat.mockImplementationOnce(async () => {
      await finished.promise
      throw new Error('Old send failure')
    })
    await view('chat')
    const pending = send('To be rejected')
    await view('workspace')
    finished.resolve()
    await pending
    expect(bridge.snapshot.value.notice).not.toContain('Old send failure')
  })
})

describe('project chat projection', () => {
  it('projects workflow references only from successful executed tools in the matching assistant turn', () => {
    const tools = [
      pendingTool('good', {
        name: 'workflow_get',
        createdAt: 2,
        status: 'executed',
        result: {
          toolCallId: 'good',
          name: 'workflow_get',
          ok: true,
          ts: 2,
          output: { workflow_ref: { id: 7, name: 'Owned' } },
        },
      }),
      pendingTool('failed', {
        name: 'workflow_get',
        createdAt: 2,
        status: 'failed',
        result: {
          toolCallId: 'failed',
          name: 'workflow_get',
          ok: false,
          ts: 2,
          output: { workflow_ref: { id: 8, name: 'Failed' } },
        },
      }),
      pendingTool('later', {
        name: 'workflow_get',
        createdAt: 5,
        status: 'executed',
        result: {
          toolCallId: 'later',
          name: 'workflow_get',
          ok: true,
          ts: 5,
          output: { workflow_ref: { id: 9, name: 'Later' } },
        },
      }),
    ]
    const result = projectChatBinding(
      project('project-a'),
      [message('first', { ts: 1 }), message('next-user', { role: 'user', ts: 4 }), message('second', { ts: 5 })],
      tools,
      false
    )
    expect(result.messages[0]?.workflows).toEqual([expect.objectContaining({ id: 7, projectId: 'project-a' })])
    expect(result.messages[1]?.workflows).toBeUndefined()
    expect(result.messages[2]?.workflows).toEqual([expect.objectContaining({ id: 9, projectId: 'project-a' })])
  })
  it('projects live projects only with bounded names/list and visible user-message counts', () => {
    const projects = [
      project('archived', { archivedAt: 1 }),
      ...Array.from({ length: 250 }, (_, index) => project(`p-${index}`, { name: 'Name'.repeat(100) })),
    ]
    const result = miniProjectList(projects, [
      message('visible', { projectId: 'p-0', role: 'user' }),
      message('hidden', { projectId: 'p-0', role: 'user', visibility: 'hidden' }),
      message('answer', { projectId: 'p-0' }),
    ])
    expect(result).toHaveLength(200)
    expect(result[0]).toMatchObject({ id: 'p-0', messageCount: 1 })
    expect(result.every(item => item.name.length <= 160)).toBe(true)
    expect(result.some(item => item.id === 'archived')).toBe(false)
  })

  it('excludes hidden/tool/foreign messages and projects safe tool metadata only', () => {
    const result = projectChatBinding(
      project('project-a'),
      [
        message('public', { raw: 'RAW SECRET', parsed: { secret: 'PARSED SECRET' } }),
        message('hidden', { visibility: 'hidden', content: 'HIDDEN SECRET' }),
        message('tool', { role: 'tool', content: 'TOOL SECRET' }),
        message('foreign', { projectId: 'project-b', content: 'FOREIGN SECRET' }),
      ],
      [pendingTool('selected'), pendingTool('foreign', { projectId: 'project-b' })],
      false
    )
    expect(result.messages.map(item => item.id)).toEqual(['public'])
    expect(result.tools).toEqual([{ id: 'selected', name: 'fs_read', status: 'proposed', detail: '' }])
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE PATH/u)
  })

  it('keeps newest messages and field limits while preserving terminal status and plain answers', () => {
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(String(index), { ts: index, content: `Answer ${index}`, meta: { summary: '' } })
    )
    messages[58]!.meta.activity = { ...createChatActivity(), status: 'failed' }
    messages[59]!.meta = {
      activity: { ...createChatActivity(), status: 'canceled' },
      bullets: Array.from({ length: 8 }, () => 'X'.repeat(900)),
      question: 'X'.repeat(2000),
    }
    const result = projectChatBinding(
      project('project-a'),
      messages,
      Array.from({ length: 30 }, (_, index) => pendingTool(String(index))),
      false
    )
    expect(result.messages).toHaveLength(40)
    expect(result.messages[0]?.id).toBe('20')
    expect(result.messages.at(-2)).toMatchObject({ content: 'Answer 58', status: 'failed' })
    expect(result.messages.at(-1)).toMatchObject({ content: 'Answer 59', status: 'canceled' })
    expect(result.messages.at(-1)?.choices).toHaveLength(4)
    expect(result.messages.at(-1)?.choices.every(choice => choice.length <= 300)).toBe(true)
    expect(result.messages.at(-1)?.question?.length).toBeLessThanOrEqual(1000)
    expect(result.tools).toHaveLength(12)
  })

  it('bounds the entire projection below native snapshot limits even with large Unicode commentary and activity', () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(String(index), {
        content: '🔒'.repeat(16000),
        meta: {
          commentary: Array.from({ length: 12 }, (_, round) => ({
            id: `round-${round}`,
            round,
            content: '🔒'.repeat(4000),
            createdAt: 1,
            serverSpeechAllowed: false,
          })),
          activity: {
            ...createChatActivity(),
            steps: Array.from({ length: 100 }, (_, step) => ({
              id: String(step),
              label: '🔒'.repeat(5000),
              detail: '🔒'.repeat(10000),
              status: 'running',
            })),
          },
        },
      })
    )
    const result = projectChatBinding(project('project-a'), messages, [], true)
    expect(result.messages.at(-1)?.id).toBe('39')
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(900000)
    expect(result.messages.at(-1)?.activity?.steps.length).toBeLessThanOrEqual(12)
  })

  it('returns an empty binding when no project is selected', () => {
    expect(projectChatBinding(undefined, [message('unrelated')], [pendingTool('unrelated')], false)).toMatchObject({
      key: 'none:empty',
      project: null,
      messages: [],
      tools: [],
      busy: false,
    })
  })
})
