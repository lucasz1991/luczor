import type { ComposerInputSource } from '@/composables/useChatComposer'

type VoiceSource = Exclude<ComposerInputSource, 'keyboard'>
type DraftOwner = {
  id: number
  scope: string
  source: VoiceSource
  base: string
  expected: string
}

/** Replace provisional hypotheses in-place, without owning unrelated/manual text. */
export function createDictationDraft(dependencies: {
  read: () => string
  write: (text: string, source: ComposerInputSource) => void
  scope: () => string
}) {
  let generation = 0
  let owner: DraftOwner | null = null

  function begin(source: VoiceSource): number {
    const base = dependencies.read()
    owner = { id: ++generation, scope: dependencies.scope(), source, base, expected: base }
    return owner.id
  }

  function owns(id: number): boolean {
    if (!owner || owner.id !== id) return false
    if (owner.scope !== dependencies.scope() || owner.expected !== dependencies.read()) {
      owner = null
      return false
    }
    return true
  }

  function replace(id: number, hypothesis: string): boolean {
    if (!owns(id) || !owner) return false
    const text = hypothesis.trim()
    const separator = owner.base && text && !/\s$/u.test(owner.base) ? ' ' : ''
    owner.expected = `${owner.base}${separator}${text}`
    dependencies.write(owner.expected, owner.source)
    return true
  }

  function finalize(id: number, transcript: string): { text: string; canAutoSubmit: boolean } | null {
    if (!replace(id, transcript) || !owner) return null
    const result = { text: owner.expected, canAutoSubmit: !owner.base.trim() && !!transcript.trim() }
    owner = null
    return result
  }

  /** Invalidates callbacks, retaining the already visible text for correction. */
  function cancel(): void {
    generation++
    owner = null
  }

  return { begin, replace, finalize, cancel }
}
