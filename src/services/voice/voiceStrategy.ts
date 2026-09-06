// Pure hands-free dictation state. Final STT segments are committed exactly once;
// interim hypotheses are replaceable previews of only the current segment.
import { pendingVoicePhraseSuffix, splitOnVoicePhrase } from './voicePhrases'

export type HandsFreeStrategy = 'continuous' | 'safeword'

export type StrategyConfig = {
  strategy: HandsFreeStrategy
  triggerPhrase: string
  endPhrase: string
  continuousSilenceMs: number
}

export type MachineState = 'armed' | 'dictating'
export type VoiceCompletionReason = 'close_word' | 'silence' | 'manual'

// Retain the existing public helper while sharing the exact matcher with VoiceEngine.
export const splitOnPhrase = splitOnVoicePhrase

type Draft = { state: MachineState; text: string; wakeTail: string }
type SegmentResult = { draft: Draft; preview: string; command: string | null; activated: boolean }

function join(left: string, right: string): string {
  return [left.trim(), right.trim()].filter(Boolean).join(' ')
}

export class HandsFreeMachine {
  state: MachineState = 'armed'
  private buffer = ''
  private wakeTail = ''
  private lastSpeechAt = 0

  constructor(
    private cfg: StrategyConfig,
    private onCommand: (text: string, reason?: VoiceCompletionReason) => void,
    private onPartial?: (text: string) => void,
    private onStateChange?: (state: MachineState) => void
  ) {}

  reset(): void {
    this.buffer = ''
    this.wakeTail = ''
    this.lastSpeechAt = 0
    this.setState('armed')
    this.onPartial?.('')
  }

  /** Finalize committed text only. An unconfirmed partial control remains ordinary speech. */
  finalize(reason: VoiceCompletionReason = 'manual'): void {
    const text = this.buffer.trim()
    this.reset()
    if (text) this.onCommand(text, reason)
  }

  /** Speech frames and pending STT work postpone continuous-mode silence submission. */
  touchSpeech(at: number): void {
    if (Number.isFinite(at)) this.lastSpeechAt = Math.max(this.lastSpeechAt, at)
  }

  /** Replace the current interim hypothesis; never commit, transition or submit. */
  previewSegment(text: string): string {
    const result = this.reduceSegment(text)
    this.onPartial?.(result.preview)
    return result.preview
  }

  /** Commit one final STT segment. Revisions must use previewSegment instead. */
  pushSegment(text: string, at: number): void {
    const result = this.reduceSegment(text)
    if (text.trim()) this.touchSpeech(at)
    this.buffer = result.draft.text
    this.wakeTail = result.draft.wakeTail
    if (result.activated) this.setState('dictating')
    this.setState(result.draft.state)
    if (result.command !== null) {
      this.onPartial?.('')
      if (result.command) this.onCommand(result.command, 'close_word')
    } else this.onPartial?.(result.preview)
  }

  /** The engine also pauses tick while audio or final transcription is pending. */
  tick(now: number): void {
    if (this.state !== 'dictating' || this.cfg.strategy !== 'continuous' || !this.buffer.trim()) return
    const silence = Number.isFinite(this.cfg.continuousSilenceMs) ? this.cfg.continuousSilenceMs : 5000
    if (Number.isFinite(now) && now - this.lastSpeechAt >= Math.max(1000, silence)) this.finalize('silence')
  }

  private setState(state: MachineState): void {
    if (this.state === state) return
    this.state = state
    this.onStateChange?.(state)
  }

  private visibleText(text: string): string {
    return this.cfg.endPhrase ? pendingVoicePhraseSuffix(text, this.cfg.endPhrase).before : text.trim()
  }

  private reduceSegment(text: string): SegmentResult {
    const clean = text.trim()
    let draft: Draft = { state: this.state, text: this.buffer, wakeTail: this.wakeTail }
    let activated = false
    if (!clean) return { draft, preview: this.visibleText(draft.text), command: null, activated }

    if (draft.state === 'armed' && this.cfg.strategy === 'safeword') {
      const combined = join(draft.wakeTail, clean)
      const wake = splitOnVoicePhrase(combined, this.cfg.triggerPhrase)
      if (!wake) {
        draft = {
          state: 'armed',
          text: '',
          wakeTail: pendingVoicePhraseSuffix(combined, this.cfg.triggerPhrase).pending,
        }
        return { draft, preview: '', command: null, activated }
      }
      draft = { state: 'dictating', text: wake.after, wakeTail: '' }
      activated = true
    } else {
      activated = draft.state === 'armed'
      draft = { state: 'dictating', text: join(draft.text, clean), wakeTail: '' }
    }

    // Also inspect the activation utterance, including a close phrase split over finals.
    const close = this.cfg.endPhrase ? splitOnVoicePhrase(draft.text, this.cfg.endPhrase) : null
    if (close) {
      return {
        draft: { state: 'armed', text: '', wakeTail: '' },
        preview: close.before,
        command: close.before,
        activated,
      }
    }
    return { draft, preview: this.visibleText(draft.text), command: null, activated }
  }
}
