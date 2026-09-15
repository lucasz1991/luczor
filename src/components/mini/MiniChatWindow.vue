<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import MiniChatSurface from './MiniChatSurface.vue'
import { emptyMiniSnapshot, MINI_STATE_EVENT, type MiniAction, type MiniSnapshot } from '@/services/miniChat/types'
import { loadAppearance } from '@/services/appearance'
const snapshot = ref(emptyMiniSnapshot())
const error = ref('')
let unlisten: UnlistenFn | undefined
let disposed = false
let lastReceipt = Date.now()
let heartbeat: ReturnType<typeof setInterval> | undefined
function accept(value: MiniSnapshot | null) {
  if (!value || typeof value.sessionId !== 'string' || !Array.isArray(value.messages)) return
  if (value.sessionId === snapshot.value.sessionId && value.revision < snapshot.value.revision) return
  snapshot.value = value
  lastReceipt = Date.now()
  error.value = ''
}
async function action(payload: MiniAction) {
  try {
    await invoke('mini_chat_action', { action: payload })
  } catch {
    error.value = 'Die Verbindung zum Hauptfenster ist unterbrochen.'
  }
}
onMounted(async () => {
  document.documentElement.classList.add('mini-window')
  // This is its own webview with its own <html> — it never inherits the main window's
  // dark/light choice unless it loads the persisted setting itself.
  void loadAppearance()
  try {
    const off = await listen<MiniSnapshot>(MINI_STATE_EVENT, event => accept(event.payload))
    if (disposed) {
      off()
      return
    }
    unlisten = off
    accept(await invoke<MiniSnapshot | null>('mini_chat_snapshot'))
    await action({ type: 'ready' })
    heartbeat = setInterval(() => {
      if (Date.now() - lastReceipt > 25_000) error.value = 'Das Hauptfenster reagiert nicht. Bitte Luczor öffnen.'
      void action({ type: 'ready' })
    }, 10_000)
  } catch {
    error.value = 'Das Hauptfenster ist nicht erreichbar.'
  }
})
onBeforeUnmount(() => {
  disposed = true
  unlisten?.()
  clearInterval(heartbeat)
})
</script>
<template><MiniChatSurface :snapshot="snapshot" native :connection-error="error" @action="action" /></template>
