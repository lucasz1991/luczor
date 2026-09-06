import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'

/** Reveal already released answer text. Never invent or append model content. */
export function useStreamReveal(
  content: Ref<string>,
  animate: Ref<boolean | undefined>,
  streaming: Ref<boolean | undefined> = ref(false)
) {
  const shown = ref(content.value)
  let timer: ReturnType<typeof setTimeout> | undefined
  function skip() {
    clearTimeout(timer)
    shown.value = content.value
  }
  function tick() {
    const target = content.value
    if (!target.startsWith(shown.value)) shown.value = ''
    const count = Math.max(12, Math.ceil((target.length - shown.value.length) / 8))
    // Do not split surrogate pairs while progressively revealing Unicode text.
    let end = Math.min(target.length, shown.value.length + count)
    if (end < target.length && /[\uD800-\uDBFF]/.test(target.charAt(end - 1))) end++
    shown.value = target.slice(0, end)
    if (shown.value.length < target.length) timer = setTimeout(tick, 24)
  }
  watch([content, animate, streaming], () => {
    clearTimeout(timer)
    const reduced =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
        document.documentElement.dataset.reduceMotion === '1')
    // Transport deltas already provide the pacing; never queue a second reveal.
    if (streaming.value || !animate.value || reduced || !content.value) {
      skip()
      return
    }
    tick()
  })
  onBeforeUnmount(() => clearTimeout(timer))
  return { shown, revealing: computed(() => shown.value !== content.value), skip }
}
