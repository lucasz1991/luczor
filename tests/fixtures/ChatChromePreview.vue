<script setup lang="ts">
// Synthetic layout states, using the production components/styles. No microphone or tool runs.
import { ref } from 'vue'
import PromptBar from '@/components/ai/PromptBar.vue'
import SidebarNav from '@/components/ai/SidebarNav.vue'
import ChatComposer from '@/components/ai/ChatComposer.vue'
import StreamingText from '@/components/ai/StreamingText.vue'
import AutonomousGoalControl from '@/components/projects/AutonomousGoalControl.vue'
import { appearance, applyAppearance, toggleTheme } from '@/services/appearance'
import '@/assets/main.css'
import '@/styles/theme.css'
import '@/styles/beautiful-ui.css'
import '@/styles/liquid-glass.css'

const input = ref('')
const speech = ref(true)
const voice = ref(true)
const context = ref(false)
applyAppearance()
</script>

<template>
  <div class="app-shell ai-workspace">
    <SidebarNav :items="[{ id: 'preview', label: 'Beispielprojekt' }]" active-id="preview" />
    <main class="main-col">
      <header class="header">
        <span>Synthetische Vorschau · Chatleisten</span>
        <button type="button" @click="toggleTheme()">{{ appearance.theme === 'light' ? 'Dunkel' : 'Hell' }}</button>
      </header>
      <ChatComposer>
        <StreamingText
          :content="'## Vorschau der Chatoberfläche\n\nTool-Protokoll, Vorleseleiste und Spracheingabe richten sich an der Promptbar aus.'"
        />
      </ChatComposer>
      <div class="audit">
        <span class="tac-label audit__title">Tool-Protokoll</span>
        <div class="empty">Noch keine Tool-Ausführungen.</div>
      </div>
      <div v-if="voice" class="voice-input-status" role="status">
        <div><strong>Spracheingabe · Vorschau</strong><span>Ein Beispielhinweis zur Aufnahme.</span></div>
        <button type="button" @click="voice = false">Aufnahme abbrechen</button>
      </div>
      <div v-if="speech" class="speech-output" aria-live="polite">
        <span>Vorlesen · Beispiel einer längeren Textpassage in der Infoleiste.</span>
        <button type="button" @click="speech = false">Vorlesen stoppen</button>
      </div>
      <div class="ai-main-composer">
        <PromptBar
          v-model="input"
          context-label="Beispielprojekt mit einem bewusst langen Projektnamen"
          @context="context = !context"
        >
          <template #heading-start><AutonomousGoalControl compact /></template>
        </PromptBar>
        <p v-if="context" role="status">Projektkontext geöffnet (Vorschau).</p>
      </div>
    </main>
  </div>
</template>

<style scoped src="../../src/styles/app-shell.css"></style>
<style scoped src="../../src/styles/ai-workspace.css"></style>
