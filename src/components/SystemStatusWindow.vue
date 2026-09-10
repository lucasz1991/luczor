<script setup lang="ts">
import { invoke } from '@tauri-apps/api/core'
import { computed } from 'vue'
import SystemStatusPanel from './SystemStatusPanel.vue'

const initialDisplayMode = computed<'tabs' | 'dashboard'>(() =>
  new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('mode') === 'dashboard' ? 'dashboard' : 'tabs'
)

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
