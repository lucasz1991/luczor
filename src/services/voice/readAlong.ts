import { readonly, shallowRef } from 'vue'

export type ReadAlongState = {
  owner: number
  key: string
  text: string
  phase: 'preparing' | 'playing' | 'waiting'
  position: number
}

const state = shallowRef<ReadAlongState | null>(null)
let generation = 0
export const readAlongState = readonly(state)

/** Transient playback data only: never written to chat history or diagnostic logs. */
export function beginReadAlong(key: string, text: string): number {
  const owner = ++generation
  state.value = { owner, key, text, phase: 'preparing', position: 0 }
  return owner
}

export function updateReadAlong(owner: number, phase: ReadAlongState['phase'], position?: number): void {
  const active = state.value
  if (active?.owner !== owner) return
  const next = Number.isFinite(position) ? Math.max(0, Math.min(active.text.length, position!)) : active.position
  if (active.phase !== phase || active.position !== next) state.value = { ...active, phase, position: next }
}

export function endReadAlong(owner: number): void {
  if (state.value?.owner === owner) state.value = null
}

export function speechTokens(text: string): { text: string; start: number; end: number; word: boolean }[] {
  return Array.from(text.matchAll(/\S+|\s+/gu), match => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
    word: /\S/u.test(match[0]),
  }))
}

/** WAV has no word timestamps. Map each sentence's real audio clock to its characters, like RailTime. */
export function sentenceSpeechPosition(start: number, length: number, time: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(time)) return start
  return start + Math.floor(Math.max(0, Math.min(1, time / duration)) * length)
}

export function currentSpeechToken(tokens: ReturnType<typeof speechTokens>, position: number): number {
  const next = tokens.findIndex(token => token.word && token.end > position)
  if (next >= 0) return next
  for (let index = tokens.length - 1; index >= 0; index--) if (tokens.at(index)?.word) return index
  return -1
}
