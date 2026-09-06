import type { ComposerInputSource } from '@/composables/useChatComposer'
import type { VoiceConfig, HandsFreeStrategyConfig } from './localVoice'
import type { VoiceEngineOptions, VoiceEngineState } from './voiceEngine'
import { createDictationDraft } from './dictationDraft'

export type VoiceInputMode = 'push_to_talk' | 'hands_free'
export type VoiceInputView = {
  mode: VoiceInputMode | null
  starting: boolean
  finishing: boolean
  status: VoiceEngineState
  notice: string
  error: string
}

export const idleVoiceInput = (): VoiceInputView => ({
  mode: null,
  starting: false,
  finishing: false,
  status: 'stopped',
  notice: '',
  error: '',
})

type Dependencies = {
  engine: {
    start(options: VoiceEngineOptions): Promise<void>
    stop(): Promise<void>
    finalize(): Promise<void>
    setMuted(value: boolean): void
  }
  readInput(): string
  writeInput(text: string, source: ComposerInputSource): void
  scope(): string
  busy(): boolean
  config(): Promise<{ voice: VoiceConfig; handsFree: HandsFreeStrategyConfig; bargeIn: boolean }>
  transcribe(wav: string, language: string): Promise<string>
  stopOutput(): void
  submit(): Promise<void>
  changed(view: VoiceInputView): void
}

/** Owns microphone-to-composer work across project, typing, settings and async boundaries. */
export function createVoiceInputSession(deps: Dependencies) {
  let view = idleVoiceInput()
  let generation = 0
  let draftId: number | null = null
  let externallyMuted = false
  let submitting = false
  const draft = createDictationDraft({ read: deps.readInput, write: deps.writeInput, scope: deps.scope })

  function update(patch: Partial<VoiceInputView>): void {
    view = { ...view, ...patch }
    deps.changed({ ...view })
  }

  function relinquishDraft(): void {
    draft.cancel()
    draftId = null
  }

  function stop(notice = ''): Promise<void> {
    generation++
    submitting = false
    relinquishDraft()
    view = idleVoiceInput()
    update({ notice })
    return deps.engine.stop()
  }

  function syncMuted(): void {
    const muted = externallyMuted || submitting
    if (muted) relinquishDraft()
    deps.engine.setMuted(muted)
  }

  function setMuted(muted: boolean): void {
    externallyMuted = muted
    if (muted && view.mode === 'push_to_talk') {
      void stop('Aufnahme pausiert. Der bisherige Text bleibt zum Prüfen stehen.')
      return
    }
    syncMuted()
  }

  function fail(error?: Error): void {
    void stop()
    update({
      status: 'error',
      error:
        (error as (Error & { code?: string }) | undefined)?.code === 'voice_backlog'
          ? 'Die lokale Spracherkennung kommt nicht nach. Aufnahme gestoppt; bisheriger Text bleibt erhalten. Bitte den letzten Abschnitt wiederholen.'
          : 'Die lokale Spracherkennung wurde gestoppt. Text prüfen und den letzten Abschnitt gegebenenfalls wiederholen; bei wiederholten Fehlern die Voice-Einstellungen und lokale Whisper-Installation prüfen.',
    })
  }

  async function start(mode: VoiceInputMode): Promise<void> {
    if (deps.busy()) return
    deps.stopOutput()
    const stopping = stop()
    const ownGeneration = generation
    const scope = deps.scope()
    const current = () => ownGeneration === generation && deps.scope() === scope
    const mayWrite = () => current() && !externallyMuted && !submitting && !deps.busy()
    update({ mode, starting: true, notice: 'Mikrofon wird geöffnet …' })
    try {
      await stopping
      if (!current()) return
      const settings = await deps.config()
      if (!current()) return
      const source: ComposerInputSource = mode === 'push_to_talk' ? 'push_to_talk' : 'hands_free'
      const handsFree =
        mode === 'push_to_talk'
          ? {
              strategy: 'continuous' as const,
              triggerPhrase: '',
              endPhrase: '',
              continuousSilenceMs: Number.MAX_SAFE_INTEGER,
            }
          : settings.handsFree
      const readyNotice =
        mode === 'push_to_talk'
          ? 'Diktat läuft. Aufnahme stoppen beendet den Text ohne Absenden.'
          : handsFree.strategy === 'safeword'
            ? `Bereit: „${handsFree.triggerPhrase}“ startet, „${handsFree.endPhrase}“ beendet und sendet den Text.`
            : `Diktat läuft. „${handsFree.endPhrase}“ beendet und sendet den Text. Eine längere Pause beendet das Diktat.`

      await deps.engine.start({
        mode: handsFree.strategy === 'safeword' ? 'wakeword' : 'continuous',
        wakeWord: settings.voice.wakeWord,
        handsFree,
        bargeIn: mode === 'hands_free' && settings.bargeIn,
        onInterrupt: () => {
          if (current()) deps.stopOutput()
        },
        transcribe: wav => deps.transcribe(wav, settings.voice.localSttLanguage),
        onStateChange: status => {
          if (current()) update({ status })
        },
        onPartial: text => {
          if (!mayWrite() || (draftId === null && !text)) return
          draftId ??= draft.begin(source)
          if (!draft.replace(draftId, text)) {
            void stop('Diktat pausiert – deine Eingabe bleibt erhalten.')
            return
          }
          if (text) update({ notice: 'Live-Vorschau im Eingabefeld – Erkennung kann sich noch ändern.' })
        },
        onCommand: (text, reason) => {
          if (!mayWrite()) return
          draftId ??= draft.begin(source)
          const result = draft.finalize(draftId, text)
          draftId = null
          if (!result) {
            void stop('Diktat pausiert – deine Eingabe bleibt erhalten.')
            return
          }
          // A confirmed close phrase is the user's spoken Send action, including a
          // visible prefix. A mere pause still needs opt-in and a wholly dictated draft.
          const closeSubmit = reason === 'close_word' && !!text.trim() && !!result.text.trim()
          const silenceSubmit = reason === 'silence' && settings.handsFree.autoSubmit && result.canAutoSubmit
          if (mode !== 'hands_free' || (!closeSubmit && !silenceSubmit)) {
            update({ notice: 'Diktat beendet. Text prüfen, bei Bedarf korrigieren und mit Enter senden.' })
            return
          }
          update({ notice: 'Diktat beendet. Nachricht wird automatisch gesendet.' })
          submitting = true
          syncMuted()
          void deps
            .submit()
            .then(() => {
              if (current()) update({ notice: 'Spracheingabe ist wieder bereit. Ergebnis im Chat prüfen.' })
            })
            .catch(() => {
              if (current())
                update({ notice: '', error: 'Der diktierte Text konnte nicht gesendet werden. Bitte prüfen.' })
            })
            .finally(() => {
              if (!current()) return
              submitting = false
              syncMuted()
            })
        },
        onError: error => {
          if (current()) fail(error)
        },
      })
      if (!current()) return
      update({ starting: false, notice: readyNotice })
      syncMuted()
    } catch (error) {
      if (!current()) return
      void stop()
      update({
        status: 'error',
        error:
          error instanceof Error && error.name === 'NotAllowedError'
            ? 'Mikrofonzugriff wurde nicht freigegeben. Bitte die Mikrofonberechtigung prüfen.'
            : 'Die lokale Spracheingabe konnte nicht gestartet werden. Bitte Mikrofon und Voice-Einstellungen prüfen.',
      })
    }
  }

  async function finish(): Promise<void> {
    if (view.mode !== 'push_to_talk' || view.starting || view.finishing) {
      await stop('Aufnahme gestoppt. Der bisherige Text bleibt zum Prüfen stehen.')
      return
    }
    const ownGeneration = generation
    update({ finishing: true, status: 'transcribing', notice: 'Letzte Wörter werden lokal erkannt …' })
    try {
      await deps.engine.finalize()
      if (ownGeneration !== generation) return
      await stop('Diktat beendet. Text prüfen, bei Bedarf korrigieren und mit Enter senden.')
    } catch {
      if (ownGeneration === generation) fail()
    }
  }

  function manualInput(): void {
    const active = view.mode !== null
    void stop(active ? 'Diktat pausiert – deine Korrektur bleibt erhalten.' : '')
  }

  return { start, stop, finish, setMuted, manualInput }
}
