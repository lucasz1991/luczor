import { describe, expect, it } from 'vitest'
import { composerHeight, useChatComposer } from '@/composables/useChatComposer'

describe('chat composer state', () => {
  it('tracks a spoken input source once and resets it after consumption', () => {
    const composer = useChatComposer()

    composer.setInput('Gesprochener Text', 'push_to_talk')

    expect(composer.input.value).toBe('Gesprochener Text')
    expect(composer.consumeInputSource()).toBe('push_to_talk')
    expect(composer.consumeInputSource()).toBe('keyboard')
  })

  it('marks real textarea input as keyboard and preserves the existing height cap', () => {
    const composer = useChatComposer()
    const element = {
      scrollHeight: 240,
      style: { height: '20px' },
    } as unknown as HTMLTextAreaElement
    composer.composerRef.value = element
    composer.setInput('Diktat überschrieben', 'hands_free')

    composer.autoGrow()

    expect(element.style.height).toBe('160px')
    expect(composer.consumeInputSource()).toBe('keyboard')
    expect(composerHeight(72)).toBe('72px')
    expect(composerHeight(240, 120)).toBe('120px')
  })

  it('does not consume the pending source before a textarea exists', () => {
    const composer = useChatComposer()
    composer.setInput('Noch nicht gerendert', 'hands_free')

    composer.autoGrow()

    expect(composer.consumeInputSource()).toBe('hands_free')
  })
})
