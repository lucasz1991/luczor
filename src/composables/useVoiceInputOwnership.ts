import { onBeforeUnmount, onMounted } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

/** Only one composer may own the microphone, including the separate Mini webview. */
export function useVoiceInputOwnership(stop: () => void) {
  const owner = crypto.randomUUID()
  const event = 'luczor:voice-input-claim'
  let unlisten: UnlistenFn | undefined
  let disposed = false
  let ready: Promise<void> = Promise.resolve()
  const local = (value: Event) => {
    if ((value as CustomEvent<string>).detail !== owner) stop()
  }
  onMounted(() => {
    window.addEventListener(event, local)
    if (isTauri())
      ready = listen<string>(event, value => {
        if (value.payload !== owner) stop()
      }).then(off => {
        if (disposed) off()
        else unlisten = off
      })
  })
  onBeforeUnmount(() => {
    disposed = true
    window.removeEventListener(event, local)
    unlisten?.()
    stop()
  })
  return async () => {
    await ready
    if (isTauri()) await invoke('voice_input_claim', { owner })
    else window.dispatchEvent(new CustomEvent(event, { detail: owner }))
  }
}
