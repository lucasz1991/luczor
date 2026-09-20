import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { DEFAULT_STATE } from '@/state/defaults'
import type { AppState, Conversation } from '@/state/types'

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

const chat = (id: string, projectId: string): Conversation => ({
  id,
  projectId,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
})
const chatState = (id: string) => state.conversations!.find(item => item.id === id)!

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', new EventTarget())
  vi.clearAllMocks()
  harness.native = true
  harness.save.mockResolvedValue(undefined)
  Object.assign(state, structuredClone(DEFAULT_STATE))
  const projectId = state.projects[0]!.id
  state.projects.push({ ...structuredClone(DEFAULT_STATE.projects[0]!), id: 'other-project', name: 'Other' })
  state.conversations = [
    chat('first-chat', projectId),
    chat('second-chat', projectId),
    chat('other-chat', 'other-project'),
  ]
})
afterEach(() => {
  for (const cleanup of harness.cleanup.splice(0)) cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const setup = (
  run = vi.fn().mockResolvedValue({ status: 'blocked', summary: 'Test benötigt Eingabe.' }),
  available: (id: string) => boolean = () => true
) => {
  const draft = ref('')
  const conversation = ref('first-chat')
  const binding = useAutonomousGoal({
    conversationId: () => conversation.value,
    available,
    draft: () => draft.value,
    run,
  })
  return { binding, draft, run, conversation }
}

describe('device-local goal binding', () => {
  it('persists a global pause without draining a stuck goal and ignores its late completion after recovery', async () => {
    let finish!: (result: unknown) => void
    const run = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue({ status: 'blocked', summary: 'New explicit run' })
    const { binding } = setup(run)
    await binding.save('Keep original progress')
    await binding.toggle(true)
    await vi.advanceTimersByTimeAsync(0)
    const pausing = binding.pauseAll('Global stopped')
    expect(binding.model.value).toMatchObject({ active: false, status: 'waiting', reason: 'Global stopped' })
    await pausing
    expect(harness.save.mock.calls.at(-1)![0].conversations[0].autonomousGoal.active).toBe(false)
    binding.recoverAfterStop()
    expect(binding.isRunning('first-chat')).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).toHaveBeenCalledOnce()
    await binding.toggle(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    finish({ status: 'completed', summary: 'Old completion', evidence: 'Old proof', reviewVerified: true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(binding.model.value).toMatchObject({ active: false, status: 'blocked', progress: 'New explicit run' })
  })

  it('pauses a saved waiting goal without a run journal before startup admission', async () => {
    const { binding, run } = setup()
    chatState('first-chat').goal = 'Recovered saved goal'
    chatState('first-chat').autonomousGoal = {
      text: 'Recovered saved goal', active: true, status: 'waiting', revision: 7,
      iterations: 2, phase: 'work', progress: 'Original checkpoint', updatedAt: 1,
    }
    await binding.pauseAll('App neu gestartet. Ziel erneut aktivieren.')
    await nextTick()
    await vi.advanceTimersByTimeAsync(5000)
    expect(run).not.toHaveBeenCalled()
    expect(binding.model.value).toMatchObject({ active: false, revision: 8, progress: 'Original checkpoint' })
  })
  it('keeps a goal running when the user switches to another chat and types there', async () => {
    let finish!: () => void
    let signal!: AbortSignal
    const { binding, draft, conversation } = setup(
      vi.fn(async (_id: string, _goal: unknown, runSignal: AbortSignal) => {
        signal = runSignal
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return { status: 'blocked', summary: 'Ergebnis des ursprünglichen Chats gesichert.' }
      })
    )
    await binding.save('Analyse im ersten Chat abschließen')
    await binding.toggle(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(binding.running.value).toBe(true)
    conversation.value = 'second-chat'
    draft.value = 'Unabhängiger neuer Auftrag'
    await nextTick()
    expect(binding.running.value).toBe(false)
    expect(binding.isRunning('first-chat')).toBe(true)
    expect(binding.model.value).toBeUndefined()
    expect(signal.aborted).toBe(false)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(chatState('first-chat').autonomousGoal?.progress).toContain('ursprünglichen Chats')
    expect(chatState('second-chat').autonomousGoal).toBeUndefined()
  })

  it('runs goals of chats from different projects side by side', async () => {
    const finishers = new Map<string, () => void>()
    const run = vi.fn(
      (id: string) =>
        new Promise<{ status: 'blocked'; summary: string }>(resolve => {
          finishers.set(id, () => resolve({ status: 'blocked', summary: `${id} fertig` }))
        })
    )
    const { binding, conversation } = setup(run)
    await binding.save('Erstes Ziel')
    await binding.toggle(true)
    conversation.value = 'other-chat'
    await nextTick()
    await binding.save('Zweites Ziel')
    await binding.toggle(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(run.mock.calls.map(call => call[0])).toEqual(['first-chat', 'other-chat'])
    expect(binding.isRunning('first-chat')).toBe(true)
    expect(binding.isRunning('other-chat')).toBe(true)
    finishers.get('first-chat')!()
    finishers.get('other-chat')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(chatState('first-chat').autonomousGoal).toMatchObject({ active: false, status: 'blocked' })
    expect(chatState('other-chat').autonomousGoal).toMatchObject({ active: false, status: 'blocked' })
  })

  it('persists the saved text before starting and does not silently activate it', async () => {
    const { binding, run } = setup()
    await binding.save('Dokumentierte Lösung erstellen')
    expect(harness.save).toHaveBeenCalled()
    expect(chatState('first-chat').goal).toBe('Dokumentierte Lösung erstellen')
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
    chatState('first-chat').autonomousGoal = {
      text: 'Neuer Entwurf',
      active: false,
      status: 'idle',
      revision: 8,
      iterations: 0,
      phase: 'work',
      updatedAt: 8,
    }
    chatState('first-chat').goal = 'Neuer Entwurf'
    release()
    await pending
    expect(binding.model.value?.text).toBe('Neuer Entwurf')
    expect(chatState('first-chat').goal).toBe('Neuer Entwurf')
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

  it('waits only for its own chat to become available, not for app pages or other chats', async () => {
    const busy = ref(new Set<string>(['first-chat']))
    const { binding, run } = setup(undefined, id => !busy.value.has(id))
    await binding.save('Nach dem laufenden Auftrag weiterarbeiten')
    await binding.toggle(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(run).not.toHaveBeenCalled()
    expect(binding.model.value).toMatchObject({ active: true, status: 'waiting' })
    busy.value = new Set(['second-chat'])
    await nextTick()
    await vi.advanceTimersByTimeAsync(1000)
    expect(run).toHaveBeenCalledTimes(1)
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

  it('deactivates saved goals of every chat on account change instead of inheriting authorization', async () => {
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
