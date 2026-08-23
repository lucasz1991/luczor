import { ref, type Ref } from 'vue'

export type ComposerInputSource = 'keyboard' | 'push_to_talk' | 'hands_free'

export type ChatComposer = {
  input: Ref<string>
  composerRef: Ref<HTMLTextAreaElement | null>
  autoGrow: () => void
  setInput: (value: string, source: ComposerInputSource) => void
  consumeInputSource: () => ComposerInputSource
}

export function composerHeight(scrollHeight: number, maxHeight = 160): string {
  return `${Math.min(scrollHeight, maxHeight)}px`
}

export function useChatComposer(maxHeight = 160): ChatComposer {
  const input = ref('')
  const composerRef = ref<HTMLTextAreaElement | null>(null)
  const pendingInputSource = ref<ComposerInputSource>('keyboard')

  function autoGrow(): void {
    const element = composerRef.value
    if (!element) return
    // Any real textarea input belongs to the keyboard turn again.
    pendingInputSource.value = 'keyboard'
    element.style.height = 'auto'
    element.style.height = composerHeight(element.scrollHeight, maxHeight)
  }

  function setInput(value: string, source: ComposerInputSource): void {
    input.value = value
    pendingInputSource.value = source
  }

  function consumeInputSource(): ComposerInputSource {
    const source = pendingInputSource.value
    pendingInputSource.value = 'keyboard'
    return source
  }

  return {
    input,
    composerRef,
    autoGrow,
    setInput,
    consumeInputSource,
  }
}
