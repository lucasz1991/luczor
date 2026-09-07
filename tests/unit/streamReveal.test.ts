import { describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref } from 'vue'
import { useStreamReveal } from '@/composables/useStreamReveal'

describe('transport-driven text reveal', () => {
  it('renders the complete current delta at the next Vue update without a reveal timer', async () => {
    vi.useFakeTimers()
    const content = ref('')
    const streaming = ref(true)
    let reveal!: ReturnType<typeof useStreamReveal>
    // Vue host renderer keeps this behavioral test independent of a browser/DOM.
    const renderer = createRenderer<object, object>({
      patchProp() {},
      insert() {},
      remove() {},
      setText() {},
      setElementText() {},
      createElement: () => ({}),
      createText: () => ({}),
      createComment: () => ({}),
      parentNode: () => null,
      nextSibling: () => null,
    })
    const app = renderer.createApp(
      defineComponent({
        setup() {
          reveal = useStreamReveal(content, ref(true), streaming)
          return () => h('div', reveal.shown.value)
        },
      })
    )
    app.mount({})
    try {
      content.value = 'Hallo 👋 ' + 'sofort '.repeat(100)
      await nextTick()
      expect(reveal.shown.value).toBe(content.value)
      expect(reveal.revealing.value).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      content.value += 'Letzter großer Transportblock. '.repeat(100)
      streaming.value = false
      await nextTick()
      expect(reveal.shown.value).toBe(content.value)
      expect(reveal.revealing.value).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      app.unmount()
      vi.useRealTimers()
    }
  })
})
