import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { DEFAULT_STATE } from '@/state/defaults'
import type { AppState } from '@/state/types'

const harness = vi.hoisted(() => ({
  save: vi.fn(),
  native: true,
  cleanup: [] as Array<() => void>,
}))
vi.mock('vue', async original => ({
  ...(await original<typeof import('vue')>()),
  onBeforeUnmount: (callback: () => void) => harness.cleanup.push(callback),
}))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => harness.native }))
vi.mock('@/services/persistence', () => ({ saveAppStateStrict: harness.save }))
vi.mock('@/services/cloudProjectAccess', () => ({ canAccessCloudProject: () => true }))
vi.mock('@/state/store', async () => {
  const { reactive } = await import('vue')
  return { state: reactive({} as AppState) }
})
import { state } from '@/state/store'
import { useAutonomousGoal } from '@/composables/useAutonomousGoal'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', new EventTarget())
  vi.clearAllMocks()
  harness.native = true
  harness.save.mockResolvedValue(undefined)
  Object.assign(state, structuredClone(DEFAULT_STATE))
})
afterEach(() => {
  for (const cleanup of harness.cleanup.splice(0)) cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const setup = (run = vi.fn().mockResolvedValue({ status: 'blocked', summary: 'Test benötigt Eingabe.' })) => {
  const draft = ref('')
  const projectId = state.projects[0]!.id
  const binding = useAutonomousGoal({
    projectId: () => projectId,
    available: () => true,
    draft: () => draft.value,
    run,
  })
  return { binding, draft, run, projectId }
}

describe('device-local goal binding', () => {
  it('persists the saved text before starting and does not silently activate it', async () => {
    const { binding, run } = setup()
    await binding.save('Dokumentierte Lösung erstellen')
    expect(harness.save).toHaveBeenCalled()
    expect(state.projects[0]?.goal).toBe('Dokumentierte Lösung erstellen')
    expect(binding.model.value).toMatchObject({ active: false, status: 'idle', phase: 'work' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).not.toHaveBeenCalled()
  })

  it('keeps the previous text when disk persistence fails', async () => {
    const { binding, run } = setup()
    harness.save.mockRejectedValue(new Error('Disk unavailable'))
    await binding.save('Neue Aufgabe')
    expect(binding.error.value).toBe('Disk unavailable')
    expect(binding.model.value).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('discards a delayed save after the goal revision changed', async () => {
    const { binding } = setup()
    let release!: () => void
    harness.save.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        })
    )
    const pending = binding.save('Alter Entwurf')
    await vi.advanceTimersByTimeAsync(0)
    state.projects[0]!.autonomousGoal = {
      text: 'Neuer Entwurf',
      active: false,
      status: 'idle',
      revision: 8,
      iterations: 0,
      phase: 'work',
      updatedAt: 8,
    }
    state.projects[0]!.goal = 'Neuer Entwurf'
    release()
    await pending
    expect(binding.model.value?.text).toBe('Neuer Entwurf')
    expect(state.projects[0]?.goal).toBe('Neuer Entwurf')
    expect(binding.error.value).toContain('erneut speichern')
  })

  it('waits for user input and then runs the explicitly activated goal', async () => {
    const { binding, draft, run } = setup()
    draft.value = 'Meine neue Nachricht'
    await binding.save('Prüfbares Ergebnis')
    await binding.toggle(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).not.toHaveBeenCalled()
    draft.value = ''
    await nextTick()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(1)
    expect(binding.model.value).toMatchObject({ active: false, status: 'blocked' })
  })

  it('refuses to schedule native work in a browser preview', async () => {
    const { binding, run } = setup()
    await binding.save('Native Aufgabe')
    harness.native = false
    await binding.toggle(true)
    expect(binding.error.value).toContain('Desktop-App')
    expect(binding.model.value?.active).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('interrupts active work when the user starts typing and ignores its late completion', async () => {
    const run = vi.fn().mockImplementation(
      (_id, _goal, signal: AbortSignal) =>
        new Promise(resolve => {
          signal.addEventListener('abort', () => resolve({ status: 'completed', summary: 'Late', evidence: 'Late' }), {
            once: true,
          })
        })
    )
    const { binding, draft } = setup(run)
    await binding.save('Eigenen Auftrag bearbeiten')
    await binding.toggle(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(binding.running.value).toBe(true)
    draft.value = 'Meine Nachricht hat Vorrang'
    await nextTick()
    await vi.advanceTimersByTimeAsync(1000)
    expect(binding.running.value).toBe(false)
    expect(binding.model.value).toMatchObject({ active: true, status: 'waiting' })
    expect(binding.model.value?.evidence).toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('deactivates a saved goal on account change instead of inheriting authorization', async () => {
    const { binding, draft, run } = setup()
    draft.value = 'Pause für Benutzer'
    await binding.save('Konto A Auftrag')
    await binding.toggle(true)
    window.dispatchEvent(new Event('luczor:api-identity-changing'))
    await nextTick()
    await vi.advanceTimersByTimeAsync(1000)
    expect(binding.model.value?.active).toBe(false)
    expect(binding.model.value?.reason).toContain('Konto gewechselt')
    expect(run).not.toHaveBeenCalled()
  })
})
