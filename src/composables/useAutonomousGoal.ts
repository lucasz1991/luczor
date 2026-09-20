import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { state } from '@/state/store'
import type { Conversation } from '@/state/types'
import { canAccessCloudProject } from '@/services/cloudProjectAccess'
import { saveAppStateStrict } from '@/services/persistence'
import {
  createAutonomousGoalController,
  type AttachedGoalRun,
  type GoalRunState,
  type GoalStepResult,
} from '@/services/goals/autonomousGoal'

/**
 * Goals belong to a chat. Every chat keeps its own saved text and run state, several
 * chats (also across projects) pursue their goals side by side, and navigating to
 * another chat, project or app page neither pauses nor interrupts them.
 * Scheduling is device-local; sharing the project never activates another device.
 */
export function useAutonomousGoal(input: {
  /** The chat shown in the composer; its goal is the one edited and displayed. */
  conversationId: () => string
  /** Whether this chat may start a goal section right now (e.g. no live user turn in it). */
  available: (conversationId: string) => boolean
  /** Composer draft of the shown chat; typing there interrupts only that chat's goal. */
  draft: () => string
  run: (conversationId: string, goal: GoalRunState, signal: AbortSignal) => Promise<GoalStepResult>
  maxConcurrent?: number
}) {
  const error = ref('')
  const current = (id: string): Conversation | undefined => {
    const chat = state.conversations?.find(item => item.id === id && !item.archivedAt)
    if (!chat) return undefined
    const project = state.projects.find(item => item.id === chat.projectId)
    return project && !project.archivedAt && canAccessCloudProject(project) ? chat : undefined
  }
  const model = computed(() => current(input.conversationId())?.autonomousGoal)
  const revision = ref(0)
  const running = computed(() => {
    void revision.value
    return controller.isRunning(input.conversationId())
  })
  const activeGoalIds = computed(() =>
    (state.conversations ?? []).filter(chat => !chat.archivedAt && chat.autonomousGoal?.active).map(chat => chat.id)
  )
  let identityGeneration = 0
  let disposed = false

  const persist = async (id: string, next: GoalRunState, expectedRevision: number, text?: string) => {
    const chat = current(id)
    if (!chat || (chat.autonomousGoal?.revision ?? 0) !== expectedRevision || disposed) return false
    const identity = identityGeneration
    const candidate = JSON.parse(JSON.stringify(state)) as typeof state
    const staged = candidate.conversations!.find(item => item.id === id)!
    staged.autonomousGoal = structuredClone(next)
    if (text !== undefined) staged.goal = text
    staged.updatedAt = Date.now()
    await saveAppStateStrict(candidate)
    const latest = current(id)
    if (
      disposed ||
      identity !== identityGeneration ||
      !latest ||
      (latest.autonomousGoal?.revision ?? 0) !== expectedRevision
    ) {
      await saveAppStateStrict(state)
      return false
    }
    latest.autonomousGoal = structuredClone(next)
    if (text !== undefined) latest.goal = text
    latest.updatedAt = staged.updatedAt
    return true
  }
  const controller = createAutonomousGoalController({
    read: id => current(id)?.autonomousGoal,
    persist,
    canRun: id =>
      !disposed &&
      !error.value &&
      isTauri() &&
      !!current(id) &&
      input.available(id) &&
      // Only the shown chat's draft blocks its own goal; other chats keep working.
      (id !== input.conversationId() || !input.draft().trim()) &&
      current(id)?.goal === current(id)?.autonomousGoal?.text,
    run: async (id, goal, signal) => {
      revision.value++
      try {
        return await input.run(id, goal, signal)
      } finally {
        revision.value++
      }
    },
    onPersistenceError: (_id, cause) => {
      error.value =
        cause instanceof Error ? cause.message : 'Ziel konnte nicht gesichert werden. Bitte erneut aktivieren.'
    },
    maxConcurrent: input.maxConcurrent,
  })
  const guarded = async (action: () => Promise<void>) => {
    error.value = ''
    try {
      await action()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : 'Ziel konnte nicht gespeichert werden.'
    }
  }
  const save = (text: string) =>
    guarded(async () => {
      if (!isTauri())
        throw new Error('Ziele werden in der Luczor-Desktop-App gespeichert. Die Browseransicht dient zur Vorschau.')
      text = text.trim()
      if (!text || text.length > 6000) throw new Error('Bitte ein Ziel mit 1 bis 6.000 Zeichen eingeben.')
      const id = input.conversationId()
      await controller.stop(id, 'Ziel wird bearbeitet.')
      const expected = current(id)?.autonomousGoal?.revision ?? 0
      const next: GoalRunState = {
        text,
        active: false,
        status: 'idle',
        revision: expected + 1,
        iterations: 0,
        phase: 'work',
        updatedAt: Date.now(),
      }
      if (!(await persist(id, next, expected, text)))
        throw new Error('Der Chat wurde gewechselt. Ziel bitte erneut speichern.')
    })
  const toggle = (active: boolean) =>
    guarded(async () => {
      const id = input.conversationId()
      if (!active) {
        await controller.stop(id, 'Von dir pausiert.')
        return
      }
      if (!isTauri()) throw new Error('Die automatische Zielbearbeitung benötigt die Luczor-Desktop-App.')
      const previous = current(id)?.autonomousGoal
      if (!previous?.text.trim()) throw new Error('Bitte zuerst ein Ziel speichern.')
      const next: GoalRunState = {
        ...previous,
        active: true,
        status: 'waiting',
        revision: previous.revision + 1,
        phase: previous.status === 'completed' ? 'work' : previous.phase,
        reason: undefined,
        stagnantIterations: 0,
        consecutiveErrors: 0,
        lastFingerprint: undefined,
        updatedAt: Date.now(),
      }
      if (await persist(id, next, previous.revision)) controller.kick(id)
    })
  const interrupt = (conversationId = input.conversationId()) =>
    guarded(() => controller.interrupt(conversationId, 'Deine Nachricht hat Vorrang.'))
  const stop = (conversationId = input.conversationId()) =>
    guarded(() => controller.stop(conversationId, 'Von dir pausiert.'))
  const isRunning = (conversationId: string) => {
    void revision.value
    return controller.isRunning(conversationId)
  }
  const runAttached = async (conversationId: string, run: AttachedGoalRun): Promise<void> => {
    const chat = current(conversationId)
    if (disposed || !isTauri() || !chat || chat.goal !== chat.autonomousGoal?.text)
      throw new Error('Das aktive Ziel gehört nicht mehr zum verfügbaren Chat.')
    revision.value++
    try {
      await controller.runAttached(conversationId, async (goal, signal) => {
        revision.value++
        return run(goal, signal)
      })
    } finally {
      revision.value++
    }
  }
  const pauseAll = async (reason = 'Alle Agenten gestoppt. Ziel bei Bedarf erneut aktivieren.') => {
    identityGeneration++
    const chats = state.conversations ?? []
    controller.cancelAll(
      chats.map(chat => chat.id),
      reason
    )
    // Persist logical cancellation before waiting for any worker. A stuck model cannot keep a goal active on restart.
    for (const chat of chats) {
      const goal = chat.autonomousGoal
      if (!goal || (!goal.active && !['running', 'checking'].includes(goal.status))) continue
      chat.autonomousGoal = {
        ...goal,
        active: false,
        status: goal.status === 'completed' ? 'completed' : 'waiting',
        phase: 'work',
        revision: goal.revision + 1,
        reason,
        updatedAt: Date.now(),
      }
    }
    revision.value++
    await saveAppStateStrict(state)
  }
  const recoverAfterStop = () => {
    controller.recoverAfterStop()
    revision.value++
  }
  const identityChanged = () => {
    identityGeneration++
    const activeIds: string[] = []
    for (const chat of state.conversations ?? []) {
      const goal = chat.autonomousGoal
      if (!goal?.active) continue
      activeIds.push(chat.id)
      chat.autonomousGoal = {
        ...goal,
        active: false,
        status: 'waiting',
        revision: goal.revision + 1,
        reason: 'Konto gewechselt. Ziel erneut aktivieren.',
        updatedAt: Date.now(),
      }
    }
    void guarded(async () => {
      for (const id of activeIds) await controller.stop(id, 'Konto gewechselt. Ziel erneut aktivieren.')
      if (activeIds.length) await saveAppStateStrict(state)
    })
  }
  window.addEventListener('luczor:api-identity-changing', identityChanged)
  const stopSchedulingWatch = watch(
    () => [
      input.conversationId(),
      input.draft(),
      model.value?.active,
      model.value?.revision,
      activeGoalIds.value.join('\u0000'),
      activeGoalIds.value.map(id => input.available(id)).join(','),
    ],
    () => {
      const shown = input.conversationId()
      if (input.draft().trim() && controller.isRunning(shown)) void interrupt(shown)
      for (const id of activeGoalIds.value) if (id !== shown || !input.draft().trim()) controller.kick(id)
    },
    { flush: 'post' }
  )
  onBeforeUnmount(() => {
    disposed = true
    stopSchedulingWatch()
    controller.dispose()
    window.removeEventListener('luczor:api-identity-changing', identityChanged)
  })
  return { model, error, running, isRunning, runAttached, save, toggle, interrupt, stop, pauseAll, recoverAfterStop }
}
