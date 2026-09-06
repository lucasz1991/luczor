import { onBeforeUnmount, ref } from 'vue'
export function useClipboard() {
  const copied = ref(false)
  const error = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined
  async function copy(text: string) {
    error.value = ''
    try {
      await navigator.clipboard.writeText(text)
      copied.value = true
      clearTimeout(timer)
      timer = setTimeout(() => {
        copied.value = false
      }, 1800)
    } catch {
      error.value = 'Kopieren nicht möglich. Bitte den Text markieren und Strg+C nutzen.'
    }
  }
  onBeforeUnmount(() => clearTimeout(timer))
  return { copy, copied, error }
}
