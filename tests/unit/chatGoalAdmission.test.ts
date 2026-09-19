import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  createAutonomousGoalController,
  createGoalRunState,
  type GoalStepResult,
} from '@/services/goals/autonomousGoal'

const app = readFileSync('src/App.vue', 'utf8')
const javascript = (source: string) =>
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText

function admittedTurn(context: Record<string, unknown>): (handle: unknown) => Promise<GoalStepResult | undefined> {
  const start = app.indexOf('      async handle => {', app.indexOf('const result = chatRuns.submit('))
  const end = app.indexOf(',\n      execution.signal', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return runInNewContext(javascript(`(${app.slice(start, end).trim()})`), context)
}

describe('App goal admission integration', () => {
  it('attaches a foreground goal to its already admitted handle and settles the same answer once', async () => {
    let goal = createGoalRunState('Implement and verify the requested report.', true)
    const scheduled = vi.fn(() => () => undefined)
    const background = vi.fn()
    const controller = createAutonomousGoalController({
      read: () => goal,
      persist: async (_id, next, revision) => {
        if (goal.revision !== revision) return false
        goal = next
        return true
      },
      canRun: () => false, // The existing foreground handle owns this conversation.
      run: background,
      schedule: scheduled,
    })
    const result: GoalStepResult = {
      status: 'completed',
      summary: 'Verified',
      evidence: 'Fresh read receipt',
      reviewVerified: true,
    }
    const executeChatTurn = vi.fn(async () => result)
    const captured = { text: 'Continue with the report.', userMessageId: 'real-user' }
    const handle = { runId: 'existing-run', signal: new AbortController().signal }
    const context = {
      responseStarted: false,
      goalInput: undefined,
      conversationId: 'chat',
      captured,
      resume: undefined,
      execution: {},
      executionGate: { assert: vi.fn() },
      mutations: { getConversation: () => ({ autonomousGoal: goal }) },
      autonomousGoal: { runAttached: controller.runAttached },
      executeChatTurn,
    }
    try {
      expect(await admittedTurn(context)(handle)).toEqual(result)
      expect(executeChatTurn).toHaveBeenCalledExactlyOnceWith(
        captured,
        handle,
        undefined,
        expect.objectContaining({ foreground: true, state: expect.objectContaining({ phase: 'work' }) })
      )
      expect(context.responseStarted).toBe(true)
      expect(goal).toMatchObject({ active: false, status: 'completed', iterations: 1 })
      expect(background).not.toHaveBeenCalled()
      expect(scheduled).not.toHaveBeenCalled()
    } finally {
      controller.dispose()
    }
  })

  it.each([false, true])('executes once if the goal is absent or deactivated before attach (race=%s)', async race => {
    const handle = { runId: 'existing-run' }
    const executeChatTurn = vi.fn(async () => undefined)
    const runAttached = vi.fn(async () => undefined)
    const context = {
      responseStarted: false,
      goalInput: undefined,
      conversationId: 'chat',
      captured: {},
      resume: undefined,
      mutations: { getConversation: () => ({ autonomousGoal: { active: race } }) },
      autonomousGoal: { runAttached },
      executeChatTurn,
    }
    await admittedTurn(context)(handle)
    expect(executeChatTurn).toHaveBeenCalledExactlyOnceWith(context.captured, handle, undefined, undefined)
    expect(runAttached).toHaveBeenCalledTimes(race ? 1 : 0)
  })

  it('does not start or fall through to a normal answer when its handle is canceled during goal admission', async () => {
    let goal = createGoalRunState('Complete the same goal.', true)
    let releaseSave!: () => void
    let admissionStarted!: () => void
    const saving = new Promise<void>(resolve => {
      releaseSave = resolve
    })
    const entered = new Promise<void>(resolve => {
      admissionStarted = resolve
    })
    const background = vi.fn()
    const controller = createAutonomousGoalController({
      read: () => goal,
      persist: async (_id, next, revision) => {
        if (next.status === 'running') {
          admissionStarted()
          await saving
        }
        if (goal.revision !== revision) return false
        goal = next
        return true
      },
      canRun: () => false,
      run: background,
      schedule: () => () => undefined,
    })
    const canceled = new AbortController()
    const handle = { runId: 'canceled-run', signal: canceled.signal }
    const executeChatTurn = vi.fn()
    const context = {
      responseStarted: false,
      goalInput: undefined,
      conversationId: 'chat',
      captured: {},
      resume: undefined,
      execution: {},
      executionGate: { assert: vi.fn() },
      mutations: { getConversation: () => ({ autonomousGoal: goal }) },
      autonomousGoal: { runAttached: controller.runAttached },
      executeChatTurn,
    }
    try {
      const pending = admittedTurn(context)(handle)
      await entered
      canceled.abort()
      releaseSave()
      expect(await pending).toBeUndefined()
      expect(executeChatTurn).not.toHaveBeenCalled()
      expect(background).not.toHaveBeenCalled()
      expect(goal).toMatchObject({ active: false, status: 'blocked' })
      expect(goal.reason).toContain('Ziel bleibt offen')
    } finally {
      releaseSave()
      controller.dispose()
    }
  })

  it('captures autonomous transcript boundaries without adding a synthetic user message', () => {
    const start = app.indexOf('    if (goalInput) {', app.indexOf('async function send('))
    const end = app.indexOf('    // Keep the submitted request on disk', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const existing = [{ id: 'last-answer', role: 'assistant' }]
    const captured = { userMessageId: '' }
    const makeMsg = vi.fn(),
      addMessage = vi.fn()
    runInNewContext(javascript(app.slice(start, end)), {
      goalInput: { state: createGoalRunState('Stored goal', true) },
      captured,
      pid: 'project',
      conversationId: 'chat',
      mutations: { getConversationMessages: () => existing, makeMsg, addMessage },
    })
    expect(captured.userMessageId).toBe('last-answer')
    expect(makeMsg).not.toHaveBeenCalled()
    expect(addMessage).not.toHaveBeenCalled()
  })
})
