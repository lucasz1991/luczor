<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadAppearance } from '@/services/appearance'
import { browserPanel } from '@/services/browserPanel'
import BrowserPanel from '@/components/browser/BrowserPanel.vue'
import AiIcon from '@/components/ai/AiIcon.vue'
import {
  disposePlaygroundNative,
  initializePlaygroundNative,
  playgroundBinding,
  requestPlaygroundAction,
} from '@/services/chatPlaygroundNative'

const error = ref('')
const ready = ref(false)
const binding = computed(() => playgroundBinding.value)
watch(binding, applyBinding)

function applyBinding() {
  const value = binding.value
  if (!value) return
  browserPanel.projectId = value.projectId
  browserPanel.conversationId = value.conversationId
  browserPanel.detached = true
  browserPanel.expanded = true
  browserPanel.viewMode = 'mini'
}

function reportBindError(reason: unknown) {
  error.value = reason instanceof Error ? reason.message : String(reason)
}

onMounted(async () => {
  document.documentElement.classList.add('chat-playground-window')
  await loadAppearance()
  try {
    await initializePlaygroundNative()
    applyBinding()
    ready.value = true
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
})

onBeforeUnmount(() => {
  document.documentElement.classList.remove('chat-playground-window')
  // The native child webview closes with this OS window. Do not send a main-window
  // layout update here: it could otherwise hide a browser belonging to another surface.
  disposePlaygroundNative()
})
</script>

<template>
  <main class="chat-playground-window">
    <div v-if="!ready" class="chat-playground-window__state" role="status">
      <AiIcon :name="error ? 'warning' : 'clock'" :size="18" />
      <strong>{{ error ? 'Chat Playground nicht verfügbar' : 'Chat Playground wird verbunden' }}</strong>
      <p v-if="error">{{ error }}</p>
    </div>
    <BrowserPanel
      v-else-if="binding"
      :project-id="binding.projectId"
      :conversation-id="binding.conversationId"
      :project-name="binding.projectName"
      :workspace-name="binding.workspaceName"
      :workspace-ready="binding.workspaceReady"
      :mode="binding.mode"
      :kill-switch="binding.killSwitch"
      detached
      @bind-folder="requestPlaygroundAction({ type: 'bind_folder' }).catch(reportBindError)"
    />
  </main>
</template>

<style>
html.chat-playground-window,
html.chat-playground-window body,
html.chat-playground-window #app {
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  margin: 0;
  overflow: hidden;
  background: var(--ai-page);
}
.chat-playground-window {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: var(--ai-page);
}
.chat-playground-window__state {
  display: grid;
  flex: 1;
  place-content: center;
  justify-items: center;
  gap: 10px;
  padding: 24px;
  color: var(--ai-muted);
  font: 12px/1.5 var(--ai-font);
  text-align: center;
}
.chat-playground-window__state strong {
  color: var(--ai-ink);
  font-size: 14px;
}
.chat-playground-window__state p {
  max-width: 440px;
  margin: 0;
}
.chat-playground-window > #browser-panel {
  flex: 1 1 auto;
  height: auto;
  min-height: 0;
  border: 0;
}
</style>
