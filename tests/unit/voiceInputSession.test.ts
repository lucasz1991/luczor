import { describe, expect, it, vi } from 'vitest'
import { createVoiceInputSession, idleVoiceInput } from '@/services/voice/voiceInputSession'
import type { VoiceEngineOptions } from '@/services/voice/voiceEngine'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(options: { input?: string; autoSubmit?: boolean } = {}) {
  let input = options.input ?? ''
  let scope = 'project-one'
  let busy = false
  let view = idleVoiceInput()
  const callbacks: VoiceEngineOptions[] = []
  const engine = {
    start: vi.fn(async (opts: VoiceEngineOptions) => {
      callbacks.push(opts)
    }),
    stop: vi.fn(async () => {}),
    finalize: vi.fn(async () => {}),
    setMuted: vi.fn(),
  }
  const configValue = {
    voice: { mode: 'wakeword' as const, wakeWord: 'luczor', localSttLanguage: 'de' },
    handsFree: {
      strategy: 'safeword' as const,
      triggerPhrase: 'luczor',
      endPhrase: 'luczor stopp',
      continuousSilenceMs: 5000,
      autoSubmit: options.autoSubmit ?? false,
    },
    bargeIn: true,
  }
  const config = vi.fn(async () => configValue)
  const submit = vi.fn(async () => {})
  const transcribe = vi.fn(async () => 'lokal erkannt')
  const stopOutput = vi.fn()
  const session = createVoiceInputSession({
    engine,
    readInput: () => input,
    writeInput: text => {
      input = text
    },
    scope: () => scope,
    busy: () => busy,
    config,
    transcribe,
    stopOutput,
    submit,
    changed: next => {
      view = next
    },
  })
  return {
    session,
    engine,
    callbacks,
    config,
    configValue,
    submit,
    transcribe,
    stopOutput,
    input: () => input,
    view: () => view,
    edit: (text: string) => {
      input = text
      session.manualInput()
    },
    project: (value: string) => {
      scope = value
    },
    busy: (value: boolean) => {
      busy = value
    },
  }
}

describe('local speech to visible composer integration', () => {
  it('shows revisions while speaking and retains a final draft without automatic submission', async () => {
    const test = setup()
    await test.session.start('hands_free')
    const voice = test.callbacks[0]!
    voice.onPartial?.('Treffen um neun')
    expect(test.input()).toBe('Treffen um neun')
    voice.onPartial?.('Treffen um zehn')
    expect(test.input()).toBe('Treffen um zehn')
    voice.onPartial?.('') // machine closes its preview before the final callback
    voice.onCommand('Treffen um zehn.')
    expect(test.input()).toBe('Treffen um zehn.')
    expect(test.submit).not.toHaveBeenCalled()
    expect(test.view().notice).toContain('Text prüfen')
    expect(test.view().mode).toBe('hands_free')
  })

  it('keeps pre-existing text and never submits that combined draft automatically', async () => {
    const test = setup({ input: 'Schon geschrieben:', autoSubmit: true })
    await test.session.start('hands_free')
    test.callbacks[0]!.onPartial?.('plus Diktat')
    test.callbacks[0]!.onCommand('plus Diktat')
    expect(test.input()).toBe('Schon geschrieben: plus Diktat')
    expect(test.submit).not.toHaveBeenCalled()
  })

  it('never submits a preview, even with explicit auto-submit enabled', async () => {
    const test = setup({ autoSubmit: true })
    await test.session.start('hands_free')
    test.callbacks[0]!.onPartial?.('vorläufige Hypothese')
    expect(test.submit).not.toHaveBeenCalled()
  })

  it('auto-submits only the owned final and pauses capture until submission settles', async () => {
    const test = setup({ autoSubmit: true })
    const pending = deferred<void>()
    test.submit.mockImplementation(() => pending.promise)
    await test.session.start('hands_free')
    const voice = test.callbacks[0]!
    voice.onCommand('fertiger Text')
    expect(test.submit).toHaveBeenCalledOnce()
    expect(test.engine.setMuted).toHaveBeenLastCalledWith(true)
    voice.onPartial?.('nicht dazwischen')
    voice.onCommand('nicht doppelt')
    expect(test.input()).toBe('fertiger Text')
    expect(test.submit).toHaveBeenCalledOnce()
    pending.resolve()
    await pending.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(test.engine.setMuted).toHaveBeenLastCalledWith(false)
  })

  it('protects a manual correction against all later recognition callbacks', async () => {
    const test = setup({ autoSubmit: true })
    await test.session.start('hands_free')
    const voice = test.callbacks[0]!
    voice.onPartial?.('Falscher Name')
    test.edit('Richtiger Name')
    voice.onPartial?.('Falscher Name erneut')
    voice.onCommand('Falscher Name erneut')
    expect(test.input()).toBe('Richtiger Name')
    expect(test.view().mode).toBeNull()
    expect(test.submit).not.toHaveBeenCalled()
  })

  it('does not let callbacks from a stopped session touch a replacement session', async () => {
    const test = setup()
    await test.session.start('hands_free')
    const old = test.callbacks[0]!
    await test.session.start('push_to_talk')
    old.onPartial?.('alte Aufnahme')
    old.onCommand('alte Aufnahme')
    old.onError?.(new Error('alte Daten'))
    test.callbacks[1]!.onPartial?.('neue Aufnahme')
    expect(test.input()).toBe('neue Aufnahme')
    expect(test.view().mode).toBe('push_to_talk')
    expect(test.view().error).toBe('')
  })

  it('blocks old project callbacks even without a watcher having run yet', async () => {
    const test = setup({ autoSubmit: true })
    await test.session.start('hands_free')
    test.project('project-two')
    test.callbacks[0]!.onPartial?.('altes Projekt')
    test.callbacks[0]!.onCommand('altes Projekt')
    expect(test.input()).toBe('')
    expect(test.submit).not.toHaveBeenCalled()
  })

  it('cancels a pending settings/start operation before microphone acquisition', async () => {
    const test = setup()
    const pending = deferred<typeof test.configValue>()
    test.config.mockImplementation(() => pending.promise)
    const start = test.session.start('hands_free')
    await Promise.resolve()
    await test.session.stop()
    pending.resolve(test.configValue)
    await start
    expect(test.engine.start).not.toHaveBeenCalled()
    expect(test.view().mode).toBeNull()
  })

  it('uses the same local transcriber and live preview for push-to-talk', async () => {
    const test = setup({ autoSubmit: true })
    await test.session.start('push_to_talk')
    const voice = test.callbacks[0]!
    expect(voice.handsFree).toMatchObject({
      strategy: 'continuous',
      endPhrase: '',
      continuousSilenceMs: Number.MAX_SAFE_INTEGER,
    })
    await voice.transcribe('synthetic-wav', 'audio/wav')
    expect(test.transcribe).toHaveBeenCalledWith('synthetic-wav', 'de')
    voice.onPartial?.('während der Aufnahme')
    expect(test.input()).toBe('während der Aufnahme')
    test.engine.finalize.mockImplementation(async () => {
      voice.onCommand('Abgeschlossener Satz.')
    })
    await test.session.finish()
    expect(test.input()).toBe('Abgeschlossener Satz.')
    expect(test.view().mode).toBeNull()
    expect(test.engine.finalize).toHaveBeenCalledOnce()
    expect(test.submit).not.toHaveBeenCalled()
  })

  it('ignores finalization results after the user canceled the drain', async () => {
    const test = setup()
    await test.session.start('push_to_talk')
    const drain = deferred<void>()
    test.engine.finalize.mockImplementation(() => drain.promise)
    const finish = test.session.finish()
    await test.session.stop()
    test.callbacks[0]!.onCommand('zu spät')
    drain.resolve()
    await finish
    expect(test.input()).toBe('')
  })

  it('pauses hands-free preview during TTS without deleting the visible draft', async () => {
    const test = setup()
    await test.session.start('hands_free')
    test.callbacks[0]!.onPartial?.('Bisher erkannt')
    test.session.setMuted(true)
    test.callbacks[0]!.onPartial?.('')
    test.callbacks[0]!.onCommand('TTS-Echo')
    expect(test.input()).toBe('Bisher erkannt')
    expect(test.engine.setMuted).toHaveBeenLastCalledWith(true)
  })

  it('stops push-to-talk when TTS starts, retaining the draft', async () => {
    const test = setup()
    await test.session.start('push_to_talk')
    test.callbacks[0]!.onPartial?.('Bisher erkannt')
    test.session.setMuted(true)
    expect(test.view().mode).toBeNull()
    expect(test.input()).toBe('Bisher erkannt')
  })

  it('does not start a second input while a model response is being generated', async () => {
    const test = setup()
    test.busy(true)
    await test.session.start('hands_free')
    expect(test.engine.start).not.toHaveBeenCalled()
  })

  it('shows a safe error instead of leaking raw transcript/runtime error content', async () => {
    const test = setup()
    await test.session.start('hands_free')
    test.callbacks[0]!.onError?.(new Error('private-transcript-with-token'))
    expect(test.view().error).toContain('lokale Spracherkennung')
    expect(JSON.stringify(test.view())).not.toContain('private-transcript')
    expect(test.view().mode).toBeNull()
  })

  it('explains bounded audio overload without exposing upstream error details', async () => {
    const test = setup()
    await test.session.start('hands_free')
    test.callbacks[0]!.onPartial?.('Schon erkannt')
    test.callbacks[0]!.onError?.(Object.assign(new Error('private-upstream-details'), { code: 'voice_backlog' }))
    expect(test.view().error).toContain('kommt nicht nach')
    expect(test.view().error).toContain('letzten Abschnitt wiederholen')
    expect(test.view().error).not.toContain('private-upstream-details')
    expect(test.input()).toBe('Schon erkannt')
  })
})
