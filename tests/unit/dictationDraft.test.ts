import { describe, expect, it } from 'vitest'
import { createDictationDraft } from '@/services/voice/dictationDraft'
import { useChatComposer } from '@/composables/useChatComposer'

function setup(initial = '') {
  const composer = useChatComposer()
  composer.setInput(initial, 'keyboard')
  let project = 'one'
  const draft = createDictationDraft({
    read: () => composer.input.value,
    write: composer.setInput,
    scope: () => project,
  })
  return { composer, draft, project: (value: string) => (project = value) }
}

describe('live dictation composer ownership', () => {
  it('replaces revised hypotheses, not one copy per update', () => {
    const { composer, draft } = setup()
    const id = draft.begin('hands_free')
    expect(draft.replace(id, 'Kaufe zwei')).toBe(true)
    expect(draft.replace(id, 'Kaufe drei Äpfel')).toBe(true)
    expect(draft.finalize(id, 'Kaufe drei Äpfel.')).toEqual({ text: 'Kaufe drei Äpfel.', canAutoSubmit: true })
    expect(composer.input.value).toBe('Kaufe drei Äpfel.')
    expect(composer.consumeInputSource()).toBe('hands_free')
    expect(draft.replace(id, 'verspätet')).toBe(false)
  })

  it('appends to an existing draft and never auto-submits existing text', () => {
    const { composer, draft } = setup('Meine Notiz:')
    const id = draft.begin('push_to_talk')
    draft.replace(id, 'Montag')
    draft.replace(id, 'Dienstag um zehn')
    expect(draft.finalize(id, 'Dienstag um zehn.')).toEqual({
      text: 'Meine Notiz: Dienstag um zehn.',
      canAutoSubmit: false,
    })
    expect(composer.input.value).toBe('Meine Notiz: Dienstag um zehn.')
  })

  it('preserves a user correction, even when the final result arrives later', () => {
    const { composer, draft } = setup()
    const id = draft.begin('hands_free')
    draft.replace(id, 'falscher Name')
    composer.setInput('korrigierter Name', 'keyboard')
    expect(draft.replace(id, 'erneut falsch')).toBe(false)
    expect(draft.finalize(id, 'erneut falsch')).toBeNull()
    expect(composer.input.value).toBe('korrigierter Name')
    expect(composer.consumeInputSource()).toBe('keyboard')
  })

  it('invalidates on manual input even if its value is unchanged', () => {
    const { composer, draft } = setup()
    const id = draft.begin('hands_free')
    draft.replace(id, 'Entwurf')
    draft.cancel()
    composer.setInput('Entwurf', 'keyboard')
    expect(draft.finalize(id, 'anderer Text')).toBeNull()
    expect(composer.input.value).toBe('Entwurf')
  })

  it('does not send an old project transcript into a new project', () => {
    const { composer, draft, project } = setup()
    const id = draft.begin('hands_free')
    project('two')
    expect(draft.replace(id, 'alt')).toBe(false)
    expect(draft.finalize(id, 'alt')).toBeNull()
    expect(composer.input.value).toBe('')
  })

  it('a canceled or replaced session cannot overwrite a newer one', () => {
    const { composer, draft } = setup()
    const first = draft.begin('hands_free')
    draft.replace(first, 'Erste Wörter')
    draft.cancel()
    const second = draft.begin('push_to_talk')
    expect(draft.replace(first, 'spät')).toBe(false)
    draft.replace(second, 'zweite Aufnahme')
    expect(composer.input.value).toBe('Erste Wörter zweite Aufnahme')
  })

  it('clears only its own provisional hypothesis when recognition revises to empty', () => {
    const { composer, draft } = setup('Bestehend\n')
    const id = draft.begin('hands_free')
    draft.replace(id, 'hypothetisch')
    draft.replace(id, '')
    expect(composer.input.value).toBe('Bestehend\n')
    expect(draft.finalize(id, '')?.canAutoSubmit).toBe(false)
  })
})
