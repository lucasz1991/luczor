import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { state } from '@/state/store'
import { canAccessCloudProject } from '@/services/cloudProjectAccess'
import { saveAppStateStrict } from '@/services/persistence'
import { createAutonomousGoalController, type GoalRunState, type GoalStepResult } from '@/services/goals/autonomousGoal'

/** Scheduling is device-local; sharing the project never activates another device. */
export function useAutonomousGoal(input: {
  projectId: () => string
  available: () => boolean
  draft: () => string
  run: (projectId: string, goal: GoalRunState, signal: AbortSignal) => Promise<GoalStepResult>
}) {
  const error = ref('')
  const running = ref(false)
  const current = (id: string) => state.projects.find(project => project.id === id && canAccessCloudProject(project))
  const model = computed(() => current(input.projectId())?.autonomousGoal)
  let identityGeneration = 0
  let disposed = false

  const persist = async (id: string, next: GoalRunState, expectedRevision: number, text?: string) => {
    const project = current(id)
    if (!project || (project.autonomousGoal?.revision ?? 0) !== expectedRevision || disposed) return false
    const identity = identityGeneration
    const candidate = JSON.parse(JSON.stringify(state)) as typeof state
    const staged = candidate.projects.find(item => item.id === id)!
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
      id === input.projectId() &&
      input.available() &&
      !input.draft().trim() &&
      !!current(id) &&
      !current(id)?.archivedAt &&
      current(id)?.goal === current(id)?.autonomousGoal?.text,
    run: async (id, goal, signal) => {
      running.value = true
      try {
        return await input.run(id, goal, signal)
      } finally {
        running.value = false
      }
    },
    onPersistenceError: (_id, cause) => {
      error.value =
        cause instanceof Error ? cause.message : 'Ziel konnte nicht gesichert werden. Bitte erneut aktivieren.'
    },
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
      const id = input.projectId()
      await controller.stop(id, 'Ziel wird bearbeitet.')
      const revision = current(id)?.autonomousGoal?.revision ?? 0
      const next: GoalRunState = {
        text,
        active: false,
        status: 'idle',
        revision: revision + 1,
        iterations: 0,
        phase: 'work',
        updatedAt: Date.now(),
      }
      if (!(await persist(id, next, revision, text)))
        throw new Error('Das Projekt wurde gewechselt. Ziel bitte erneut speichern.')
    })
  const toggle = (active: boolean) =>
    guarded(async () => {
      const id = input.projectId()
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
  const interrupt = () => guarded(() => controller.interrupt(input.projectId(), 'Deine Nachricht hat Vorrang.'))
  const stop = () => guarded(() => controller.stop(input.projectId(), 'Von dir pausiert.'))
  const identityChanged = () => {
    identityGeneration++
    const activeIds: string[] = []
    for (const project of state.projects) {
      const goal = project.autonomousGoal
      if (!goal?.active) continue
      activeIds.push(project.id)
      project.autonomousGoal = {
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
    () => [input.projectId(), input.available(), input.draft(), model.value?.active, model.value?.revision],
    () => {
      if (input.draft().trim() && running.value) void guarded(interrupt)
      else controller.kick(input.projectId())
    },
    { flush: 'post' }
  )
  // A cloud edit keeps the local run paused until its changed objective is reviewed here.
  const stopTextWatch = watch(
    () => current(input.projectId())?.goal,
    text => {
      if (model.value?.active && text !== model.value.text)
        void guarded(() =>
          controller.stop(input.projectId(), 'Das Projektziel wurde geändert. Zieltext prüfen und erneut speichern.')
        )
    }
  )
  onBeforeUnmount(() => {
    disposed = true
    stopSchedulingWatch()
    stopTextWatch()
    controller.dispose()
    window.removeEventListener('luczor:api-identity-changing', identityChanged)
  })
  return { model, error, running, save, toggle, interrupt, stop }
}
