import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { stopCapturedChatRun, type ChatStopSnapshot } from '@/services/chatRunLifecycle'
import { executionAbortReason } from '@/services/inference/interruption'
import { isSilentLocalResponseFailure } from '@/services/inference/localResponseGuard'
import { ExecutionGate } from '@/services/executionGate'

function executeRuntimeRecovery(context: Record<string, unknown>) {
  const app = readFileSync('src/App.vue', 'utf8')
  const start = app.indexOf('let stopRunRecoveryListeners:')
  const source = app.slice(start, app.indexOf('\nonBeforeUnmount', start))
  let result!: Promise<void>
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    getLocalSpeechConsent: async () => undefined,
    refreshPlanPrincipal: vi.fn(),
    recoverResearch: vi.fn(async () => {}),
    researchRuns: { value: [] },
    stopAllVoice: vi.fn(),
    stopVoiceInputForSettings: vi.fn(),
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    executionGate: new ExecutionGate(),
    mutations: { getConversation: vi.fn() },
    hud: { killSwitch: false },
    ...context,
    onMounted: (callback: () => Promise<void>) => {
      result = callback()
    },
  })
  return result
}

function workingContextFunction(name: string, context: Record<string, unknown>) {
  const app = readFileSync('src/App.vue', 'utf8')
  const start = app.indexOf(`async function ${name}(`)
  const end =
    name === 'prepareWorkingContext'
      ? app.indexOf('\nasync function restoreWorkingContexts', start)
      : app.indexOf('\ntype CapturedChatTurn', start)
  return runInNewContext(
    ts.transpileModule(app.slice(start, end) + `\n${name}`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context
  )
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => (resolve = done))
  return { promise, resolve }
}

function fixture(controller: AbortController | null = new AbortController()) {
  let current: ChatStopSnapshot = {
    generation: 1,
    controller,
    cancel: controller ? vi.fn(async () => controller.abort()) : null,
  }
  const finishCurrent = vi.fn()
  const clearCurrent = vi.fn(() => {
    current.controller = null
    current.cancel = null
  })
  const options = {
    capture: () => ({ ...current }),
    isCurrent: (snapshot: ChatStopSnapshot) =>
      snapshot.generation === current.generation &&
      snapshot.controller === current.controller &&
      snapshot.cancel === current.cancel,
    finishCurrent,
    clearCurrent,
  }
  return {
    options,
    get current() {
      return current
    },
    admit(controller: AbortController | null = new AbortController()) {
      current = { generation: current.generation + 1, controller, cancel: null }
      return controller
    },
  }
}

describe('working-context recovery identity boundaries', () => {
  it('restores a missing local research card only for an existing conversation after archive recovery', async () => {
    const waiting = deferred()
    const chat = { id: 'chat', projectId: 'p' }
    const state = { conversations: [chat], messages: [] as Array<{ id: string; meta: Record<string, unknown> }> }
    const recovered = { value: [] as Array<{ id: string; projectId: string; conversationId: string }> }
    const ready = { value: false }
    const restore = vi.fn(async () => {})
    const save = vi.fn(async () => {})
    const recoverResearch = vi.fn(async () => {
      await waiting.promise
      recovered.value = [
        { id: 'saved-research', projectId: 'p', conversationId: 'chat' },
        { id: 'deleted-chat-research', projectId: 'p', conversationId: 'deleted' },
      ]
    })
    const pending = executeRuntimeRecovery({
      appRuntimeLifecycle: { start: async () => undefined },
      resolveWorkspacePrincipalId: async () => 'person',
      chatRuns: { recover: async () => {}, records: { value: [] } },
      researchRuns: recovered,
      recoverResearch,
      reconcileRecoveredChatRuns: vi.fn(),
      saveAppStateStrict: save,
      restoreWorkingContexts: restore,
      state,
      appReady: ready,
      appInitialized: { value: false },
      appQuitting: { value: false },
      appUnmounted: false,
      mutations: {
        getConversation: (id: string) => (id === chat.id ? chat : undefined),
        makeMsg: () => ({ id: 'new', meta: {} }),
        addMessage: (message: { id: string; meta: Record<string, unknown> }) => state.messages.push(message),
      },
      console: { warn: vi.fn() },
    })
    await vi.waitFor(() => expect(recoverResearch).toHaveBeenCalledOnce())
    expect(ready.value).toBe(false)
    expect(restore).not.toHaveBeenCalled()
    waiting.resolve()
    await pending
    expect(ready.value).toBe(true)
    expect(state.messages).toEqual([
      {
        id: 'research:saved-research',
        meta: {
          researchRunId: 'saved-research',
          retentionPolicy: 'local_only',
          serverSpeechAllowed: false,
        },
      },
    ])
    expect(save).toHaveBeenCalledOnce()
  })
  it.each(['principal', 'workspace', 'archive'])('rejects an identity change during %s preparation', async stage => {
    const gate = new ExecutionGate()
    const waiting = deferred()
    const prepareResume = vi.fn(async () => {
      if (stage === 'archive') await waiting.promise
      return { status: 'ready', checkpoint: {} }
    })
    const getProjectWorkspace = vi.fn(async () => {
      if (stage === 'workspace') await waiting.promise
      return { status: 'ready', rootPath: '/synthetic', updatedAt: 1 }
    })
    const currentArchivePrincipal = vi.fn(async () => {
      if (stage === 'principal') await waiting.promise
      return 'person'
    })
    const prepare = workingContextFunction('prepareWorkingContext', {
      executionGate: gate,
      currentArchivePrincipal,
      isTauri: () => true,
      getProjectWorkspace,
      runCoordinator: { prepareResume },
    })
    const pending = prepare({ scope: { principalId: 'person', projectId: 'p' }, messageId: 'answer' })
    const probe =
      stage === 'archive' ? prepareResume : stage === 'workspace' ? getProjectWorkspace : currentArchivePrincipal
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    gate.invalidate()
    waiting.resolve()
    await expect(pending).rejects.toThrow('Ausführung verworfen')
    expect(prepareResume).toHaveBeenCalledTimes(stage === 'archive' ? 1 : 0)
  })

  function restoreFixture() {
    const gate = new ExecutionGate()
    const goal = {
      text: 'Synthetisches Ziel',
      active: false,
      status: 'waiting',
      revision: 2,
      iterations: 1,
      lastMessageId: 'answer',
      updatedAt: 1,
    }
    const chat = { id: 'chat', projectId: 'p', autonomousGoal: goal }
    const reference = {
      scope: { principalId: 'person', projectId: 'p', conversationId: 'chat', runId: 'run' },
      messageId: 'answer',
      state: 'working',
      updatedAt: 2,
    }
    const context = {
      executionGate: gate,
      currentArchivePrincipal: async () => 'person',
      runCoordinator: { listRecoverable: vi.fn(async () => [reference]) },
      state: { projects: [{ id: 'p' }], conversations: [chat], messages: [{ id: 'answer', conversationId: 'chat' }] },
      mutations: { getConversation: () => chat },
      canAccessCloudProject: () => true,
      continuations: { value: {} },
      goalWorkingContexts: new Map(),
      prepareWorkingContext: vi.fn(async (): Promise<void> => undefined),
    }
    return { gate, goal, chat, context, restore: workingContextFunction('restoreWorkingContexts', context) }
  }

  it.each(['listing', 'preparation'])(
    'publishes no stale references or goals after identity changes during %s',
    async stage => {
      const { gate, chat, context, restore } = restoreFixture()
      const waiting = deferred()
      if (stage === 'listing')
        context.runCoordinator.listRecoverable.mockImplementation(async () => {
          await waiting.promise
          return []
        })
      else context.prepareWorkingContext.mockImplementation(() => waiting.promise)
      const pending = restore(new Map([['chat', 2]]), gate.capture())
      await vi.waitFor(() =>
        expect(
          stage === 'listing' ? context.runCoordinator.listRecoverable : context.prepareWorkingContext
        ).toHaveBeenCalledOnce()
      )
      gate.invalidate()
      const newGoal = { ...chat.autonomousGoal, revision: 3 }
      chat.autonomousGoal = newGoal
      waiting.resolve()
      await expect(pending).rejects.toThrow('Ausführung verworfen')
      expect(chat.autonomousGoal).toBe(newGoal)
      expect(context.continuations.value).toEqual({})
      expect(context.goalWorkingContexts.size).toBe(0)
    }
  )

  it('preserves a newer user goal revision while preparing an otherwise valid archive', async () => {
    const { gate, chat, context, restore } = restoreFixture()
    const waiting = deferred()
    context.prepareWorkingContext.mockImplementation(() => waiting.promise)
    const pending = restore(new Map([['chat', 2]]), gate.capture())
    await vi.waitFor(() => expect(context.prepareWorkingContext).toHaveBeenCalledOnce())
    const edited = { ...chat.autonomousGoal, revision: 3, text: 'Geändertes Ziel' }
    chat.autonomousGoal = edited
    waiting.resolve()
    await pending
    expect(chat.autonomousGoal).toBe(edited)
  })

  it('does not publish another principal archive even if a stale provider returns it', async () => {
    const { gate, context, restore } = restoreFixture()
    const records = await context.runCoordinator.listRecoverable()
    context.runCoordinator.listRecoverable.mockResolvedValue(
      records.map(record => ({
        ...record,
        scope: { ...record.scope, principalId: 'other-person' },
      }))
    )
    await restore(new Map(), gate.capture())
    expect(context.continuations.value).toEqual({})
    expect(context.goalWorkingContexts.size).toBe(0)
    expect(context.prepareWorkingContext).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'binds restored goals to reconciliation without reviving a user edit (edited=%s)',
    async edited => {
      const waiting = deferred()
      const chat = { id: 'chat', autonomousGoal: { active: true, revision: 1 } }
      const restore = vi.fn(async (_goals: ReadonlyMap<string, number>) => undefined)
      const recover = vi.fn(() => waiting.promise)
      const records = [{ principalId: 'person' }, { principalId: 'other-person' }]
      const reconcile = vi.fn(() => {
        chat.autonomousGoal = { active: false, revision: chat.autonomousGoal.revision + 1 }
      })
      const pending = executeRuntimeRecovery({
        appRuntimeLifecycle: { start: async () => undefined },
        resolveWorkspacePrincipalId: async () => 'person',
        chatRuns: { recover, records: { value: records } },
        reconcileRecoveredChatRuns: reconcile,
        saveAppStateStrict: async () => undefined,
        restoreWorkingContexts: restore,
        mutations: { getConversation: () => chat },
        state: { conversations: [chat] },
        appReady: { value: false },
        appInitialized: { value: false },
        appQuitting: { value: false },
        appUnmounted: false,
        console: { warn: vi.fn() },
      })
      await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
      if (edited) chat.autonomousGoal = { active: false, revision: 2 }
      waiting.resolve()
      await pending
      expect(restore).toHaveBeenCalledOnce()
      expect(reconcile).toHaveBeenCalledExactlyOnceWith(expect.anything(), [records[0]])
      expect([...restore.mock.calls[0]![0]]).toEqual(edited ? [] : [['chat', 2]])
    }
  )

  it.each(['journal', 'hydration'])(
    'recovers readiness for the new identity without replaying old goals during %s',
    async stage => {
      const gate = new ExecutionGate()
      const oldWork = deferred()
      const listeners = new Map<string, () => void>()
      const chat = { id: 'chat', autonomousGoal: { active: true, revision: 1, iterations: 0 } }
      let principal = 'old'
      const restore = vi.fn(async (_goals: ReadonlyMap<string, number>, _ticket: unknown) => undefined)
      const context = {
        executionGate: gate,
        window: {
          addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
          removeEventListener: vi.fn(),
        },
        appRuntimeLifecycle: {
          start: vi.fn(async () => {
            if (stage === 'hydration') {
              await oldWork.promise
              chat.autonomousGoal = { active: true, revision: 1, iterations: 0 }
            }
          }),
        },
        resolveWorkspacePrincipalId: async () => principal,
        chatRuns: {
          recover: vi.fn(async (id: string) => {
            if (stage === 'journal' && id === 'old') await oldWork.promise
          }),
          records: { value: [] },
        },
        reconcileRecoveredChatRuns: vi.fn(),
        saveAppStateStrict: vi.fn(async () => undefined),
        restoreWorkingContexts: restore,
        mutations: { getConversation: () => chat },
        state: { conversations: [chat] },
        appReady: { value: false },
        appInitialized: { value: false },
        appQuitting: { value: false },
        appUnmounted: false,
        console: { warn: vi.fn() },
      }
      const stale = executeRuntimeRecovery(context)
      const started = stage === 'journal' ? context.chatRuns.recover : context.appRuntimeLifecycle.start
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
      gate.invalidate()
      listeners.get('luczor:api-identity-changing')!()
      chat.autonomousGoal = { ...chat.autonomousGoal, active: false, revision: 2 }
      principal = 'new'
      listeners.get('luczor:api-identity-changed')!()
      oldWork.resolve()
      await stale
      await vi.waitFor(() => expect(context.appReady.value).toBe(true))
      expect(context.appInitialized.value).toBe(true)
      expect(restore).toHaveBeenCalledOnce()
      expect([...(restore.mock.calls[0]![0] as Map<string, number>)]).toEqual([])
      expect(chat.autonomousGoal.active).toBe(false)
      expect(context.appRuntimeLifecycle.start).toHaveBeenCalledOnce()
      expect(context.console.warn).not.toHaveBeenCalled()
    }
  )
})

describe('captured chat cancellation', () => {
  it('retracts only the captured unfinished answer and resets speech before patching shared main/mini state', () => {
    const app = readFileSync('src/App.vue', 'utf8')
    const start = app.indexOf('onResponseReset: () => {')
    const source = app
      .slice(start + 'onResponseReset: '.length, app.indexOf('\n      onRoundComplete:', start))
      .trim()
      .replace(/,$/, '')
    const controller = new AbortController()
    const order: string[] = []
    const patchMessage = vi.fn(() => {
      order.push('patch')
    })
    const resetCurrent = vi.fn(() => {
      order.push('speech')
    })
    const reset = runInNewContext(`(${source})`, {
      turnExecution: { signal: controller.signal },
      progressiveSpeech: { resetCurrent },
      mutations: { patchMessage },
      pid: 'captured-project',
      assistant: { id: 'captured-answer' },
    }) as () => void
    reset()
    expect(order).toEqual(['speech', 'patch'])
    expect(patchMessage).toHaveBeenCalledExactlyOnceWith('captured-project', 'captured-answer', {
      content: '',
      raw: '',
      parsed: null,
      meta: { question: '', summary: '', bullets: [] },
    })
    controller.abort()
    reset()
    expect(resetCurrent).toHaveBeenCalledOnce()
    expect(patchMessage).toHaveBeenCalledOnce()
  })

  it.each([
    undefined,
    { code: 'runtime_output_repeated' },
    { code: 'runtime_status_echo' },
    { code: 'runtime_text_tool_output' },
  ])('does not automatically read stopped loops or exhausted correction diagnostics: %j', interrupted => {
    const app = readFileSync('src/App.vue', 'utf8')
    const start = app.indexOf('if (isSilentLocalResponseFailure(interrupted?.code)) progressiveSpeech.cancel()')
    expect(start).toBeGreaterThan(0)
    // Execute exactly the speech decision, independent of subsequent memory or
    // goal finalization statements and their return values.
    const parsed = ts.createSourceFile('speech.ts', app.slice(start), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
    const decision = parsed.statements[0]!
    expect(ts.isIfStatement(decision)).toBe(true)
    const source = decision.getText(parsed)
    const cancel = vi.fn(),
      completeAnswer = vi.fn()
    runInNewContext(source, {
      interrupted,
      isSilentLocalResponseFailure,
      progressiveSpeech: { cancel, completeAnswer },
      isVisible: () => true,
      turnSpeechGeneration: 1,
      speechGeneration: 1,
    })
    expect(cancel).toHaveBeenCalledTimes(interrupted ? 1 : 0)
    expect(completeAnswer).toHaveBeenCalledTimes(interrupted ? 0 : 1)
  })

  it('keeps automatic and manual admission closed until journal recovery and its public-state save finish', async () => {
    const recovery = deferred(),
      saved = deferred(),
      restored = deferred()
    const context = {
      appRuntimeLifecycle: { start: async () => undefined },
      resolveWorkspacePrincipalId: async () => 'person',
      chatRuns: { recover: () => recovery.promise, records: { value: [] } },
      reconcileRecoveredChatRuns: vi.fn(() => 1),
      saveAppStateStrict: vi.fn(() => saved.promise),
      restoreWorkingContexts: vi.fn(() => restored.promise),
      state: {},
      appReady: { value: false },
      appInitialized: { value: false },
      appQuitting: { value: false },
      appUnmounted: false,
      console: { warn: vi.fn() },
    }
    const result = executeRuntimeRecovery(context)
    await Promise.resolve()
    expect(context.appReady.value).toBe(false)
    expect(context.appInitialized.value).toBe(false)
    recovery.resolve()
    await vi.waitFor(() => expect(context.restoreWorkingContexts).toHaveBeenCalledOnce())
    expect(context.appReady.value).toBe(false)
    expect(context.appInitialized.value).toBe(false)
    restored.resolve()
    await vi.waitFor(() => expect(context.saveAppStateStrict).toHaveBeenCalledOnce())
    expect(context.appReady.value).toBe(false)
    expect(context.appInitialized.value).toBe(false)
    saved.resolve()
    await result
    expect(context.appReady.value).toBe(true)
    expect(context.appInitialized.value).toBe(true)
  })

  it('keeps automatic goals disabled when journal recovery is unavailable', async () => {
    const context = {
      appRuntimeLifecycle: { start: async () => undefined },
      resolveWorkspacePrincipalId: async () => 'person',
      chatRuns: {
        recover: async () => {
          throw new Error('journal unavailable')
        },
        records: { value: [] },
      },
      reconcileRecoveredChatRuns: vi.fn(() => 1),
      saveAppStateStrict: vi.fn(),
      state: {},
      appReady: { value: false },
      appInitialized: { value: false },
      appQuitting: { value: false },
      appUnmounted: false,
      console: { warn: vi.fn() },
    }
    await executeRuntimeRecovery(context)
    expect(context.appReady.value).toBe(false)
    expect(context.appInitialized.value).toBe(true)
    expect(context.reconcileRecoveredChatRuns).not.toHaveBeenCalled()
    expect(context.console.warn).toHaveBeenCalledOnce()
  })

  it('the App stop handler captures run IDs before awaiting goal teardown and leaves a newly selected run alive', async () => {
    const app = readFileSync('src/App.vue', 'utf8')
    const start = app.indexOf('async function stopGenerating(')
    const source = app.slice(start, app.indexOf('\nfunction openProject(', start))
    const goal = deferred()
    const records = [{ runId: 'old', conversationId: 'one', projectId: 'project', state: 'running' }]
    const activeConversationId = { value: 'one' }
    const stop = vi.fn(async () => undefined)
    const context = {
      chatRuns: { records: { value: records }, stop },
      chatRunIsLive: (run: { state: string }) => run.state === 'running',
      activeConversationId,
      state: { pending: { toolCallsByProject: {} } },
      getSafeRecordValue: () => [],
      resolveApproval: vi.fn(),
      executionAbortReason,
      autonomousGoal: { running: { value: true }, stop: () => goal.promise },
      stopVoiceOutput: vi.fn(),
    }
    const stopGenerating = runInNewContext(`${source}\nstopGenerating`, context) as () => Promise<void>
    const pending = stopGenerating()
    expect(stop).toHaveBeenCalledExactlyOnceWith('old', expect.anything())
    records.push({ runId: 'new', conversationId: 'two', projectId: 'project', state: 'running' })
    activeConversationId.value = 'two'
    goal.resolve()
    await pending
    expect(stop).toHaveBeenCalledOnce()
    expect(context.stopVoiceOutput).toHaveBeenCalledOnce()
  })

  it('aborts the captured answer immediately and never cancels a new answer after goal teardown', async () => {
    const context = fixture()
    const previous = context.current.controller!
    const goal = deferred()
    const stopping = stopCapturedChatRun({ ...context.options, pauseGoal: () => goal.promise })
    expect(previous.signal.aborted).toBe(true)
    expect(context.options.finishCurrent).toHaveBeenCalledTimes(1)
    const next = context.admit()!
    goal.resolve()
    await stopping
    expect(next.signal.aborted).toBe(false)
    expect(context.options.finishCurrent).toHaveBeenCalledTimes(1)
    expect(context.options.clearCurrent).not.toHaveBeenCalled()
    expect(context.current.controller).toBe(next)
  })

  it('does not clear the new turn while an old cancellation callback settles', async () => {
    const context = fixture()
    const cancellation = deferred()
    context.current.cancel = vi.fn(() => cancellation.promise)
    const oldCancel = context.current.cancel
    const stopping = stopCapturedChatRun(context.options)
    const next = context.admit()!
    cancellation.resolve()
    await stopping
    expect(oldCancel).toHaveBeenCalledTimes(1)
    expect(next.signal.aborted).toBe(false)
    expect(context.options.clearCurrent).not.toHaveBeenCalled()
  })

  it('protects a newly admitted turn even when both old and new controllers are still null', async () => {
    const context = fixture(null)
    const goal = deferred()
    const stopping = stopCapturedChatRun({ ...context.options, pauseGoal: () => goal.promise })
    context.admit(null)
    goal.resolve()
    await stopping
    expect(context.options.clearCurrent).not.toHaveBeenCalled()
    expect(context.options.finishCurrent).toHaveBeenCalledTimes(1)
  })

  it('cleans up the same current turn after all cancellation work settles', async () => {
    const context = fixture()
    const goal = deferred()
    const stopping = stopCapturedChatRun({ ...context.options, pauseGoal: () => goal.promise })
    expect(context.options.clearCurrent).not.toHaveBeenCalled()
    goal.resolve()
    await stopping
    expect(context.options.clearCurrent).toHaveBeenCalledTimes(1)
    expect(context.current.controller).toBeNull()
  })

  it('still aborts the captured controller when auxiliary cleanup throws', async () => {
    const context = fixture()
    const previous = context.current.controller!
    context.current.cancel = () => Promise.reject(new Error('Already stopped'))
    await stopCapturedChatRun({
      ...context.options,
      pauseGoal: () => {
        throw new Error('Persistence unavailable')
      },
    })
    expect(previous.signal.aborted).toBe(true)
    expect(context.options.clearCurrent).toHaveBeenCalledTimes(1)
  })
})
