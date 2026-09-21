import { onBeforeUnmount, watch, type Ref } from 'vue'

/**
 * Closes a popover/dropdown when the pointer goes down outside its root, when focus leaves it,
 * or on Escape. Listeners exist only while it is open, so idle controls cost nothing.
 */
export function useDismissible(
  open: Ref<boolean>,
  root: Ref<HTMLElement | null>,
  options: { onClose?: () => void; escape?: boolean; focusOut?: boolean } = {}
): { close(): void } {
  const close = () => {
    if (!open.value) return
    open.value = false
    options.onClose?.()
  }
  const onPointer = (event: PointerEvent) => {
    const target = event.target as Node | null
    if (target && root.value && !root.value.contains(target)) close()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && options.escape !== false) {
      event.preventDefault()
      close()
    }
  }
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target as Node | null
    if (options.focusOut !== false && target && root.value && !root.value.contains(target)) close()
  }
  const attach = () => {
    // Capture phase: a click on another control closes this one before that control reacts.
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocusIn, true)
  }
  const detach = () => {
    document.removeEventListener('pointerdown', onPointer, true)
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('focusin', onFocusIn, true)
  }
  watch(
    open,
    value => {
      if (typeof document === 'undefined') return
      if (value) attach()
      else detach()
    },
    { immediate: true }
  )
  onBeforeUnmount(detach)
  return { close }
}
