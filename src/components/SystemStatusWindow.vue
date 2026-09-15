<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { computed, onMounted } from 'vue'
import SystemStatusPanel from './SystemStatusPanel.vue'
import { loadAppearance } from '@/services/appearance'

const initialDisplayMode = computed<'tabs' | 'dashboard'>(() =>
  new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('mode') === 'dashboard' ? 'dashboard' : 'tabs'
)

// This is its own webview with its own <html> — it never inherits the main window's dark/light
// choice unless it loads the persisted setting itself.
onMounted(() => void loadAppearance())

async function close() {
  try {
    await invoke('system_status_window_close')
  } catch {
    window.close()
  }
}
</script>

<template>
  <SystemStatusPanel native-window :initial-display-mode="initialDisplayMode" @close="close" />
</template>
