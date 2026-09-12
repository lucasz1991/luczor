<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import ChatComposer from '@/components/ai/ChatComposer.vue'
import ChatAgentRoster from '@/components/ai/ChatAgentRoster.vue'
import ThinkingState from '@/components/ai/ThinkingState.vue'
import ToolChips from '@/components/ai/ToolChips.vue'
import ChatCommentary from '@/components/ai/ChatCommentary.vue'
import StreamingText from '@/components/ai/StreamingText.vue'
import AgentTeamResults from '@/components/ai/AgentTeamResults.vue'
import PromptBar from '@/components/ai/PromptBar.vue'
import AiIcon from '@/components/ai/AiIcon.vue'
import MiniChatSurface from '@/components/mini/MiniChatSurface.vue'
import { emptyMiniSnapshot } from '@/services/miniChat/types'
import { createChatActivity, updateChatActivity, finishChatActivity, activityLabel } from '@/services/chatActivity'
import type { ActivityStep } from '@/components/ai/types'
import type { ChatCommentary as Commentary } from '@/state/types'
import type { SpecialistOutcome } from '@/services/agents/externalSpecialists'
const message = 'Bitte prüfe den Chatverlauf. Agenten, Werkzeuge und Zwischenstände sollen klar erkennbar sein.'
const result =
  '## Ein klarer Verlauf für jede Aufgabe\n\nDie Antwort bleibt im Mittelpunkt. Darüber siehst du, **wer gerade arbeitet**, welche Werkzeuge beteiligt sind und was bereits geprüft wurde.\n\n- **Planung** ordnet den Auftrag und legt die nächsten Schritte fest.\n- **Bearbeitung** führt die Schritte aus und liefert das Ergebnis.\n- **Prüfung** untersucht offene Punkte und fasst ihre Befunde zusammen.\n\n### Fortschritt ohne Informationsflut\n\nZwischenmeldungen bleiben lesbar. Frühere Meldungen und technische Details lassen sich bei Bedarf öffnen. Im Mini-Chat stehen dieselben Zustände und Aktionen bereit.'
const activity = ref(createChatActivity(Date.now() - 9400))
const content = ref(result)
const tools = ref<ActivityStep[]>([])
const mode = ref('done')
const narrow = ref(false)
const showMini = ref(false)
const draft = ref('')
const commentary: Commentary[] = [
  {
    id: 'comment-1',
    round: 1,
    content: 'Ich prüfe zunächst, welche Arbeitsschritte und Werkzeugereignisse bereits im Chat ankommen.',
    createdAt: Date.now() - 7000,
    serverSpeechAllowed: false,
  },
  {
    id: 'comment-2',
    round: 2,
    content:
      'Die öffentlichen Ereignisse sind vorhanden. Ich ordne sie nach Agentenrolle und halte Werkzeugdetails direkt am jeweiligen Aufruf verfügbar.',
    createdAt: Date.now() - 4000,
    serverSpeechAllowed: false,
  },
]
const outcomes: SpecialistOutcome[] = [
  {
    role: 'planning',
    model: 'Beispielmodell',
    provider: 'Lokal',
    output:
      '### Vorgehen\n\n1. Arbeitsschritte nach Rollen gliedern.\n2. Werkzeugzustände direkt am Aufruf zeigen.\n3. Den Abschluss im Mini-Chat gegenprüfen.',
    durationMs: 3200,
    tokenUsage: { inputTokens: 810, outputTokens: 164, totalTokens: 974, source: 'reported', rounds: 1 },
  },
  {
    role: 'review',
    model: 'Beispielmodell',
    provider: 'Lokal',
    output:
      '### Prüfbefund\n\nDie Anzeige unterscheidet **Abschluss**, **Fehler** und **Abbruch**. Unbekannte Zustände werden nicht als Erfolg angezeigt.\n\nOffen bleibt die Abnahme mit einem echten Modelllauf.',
    durationMs: 1800,
    tokenUsage: { inputTokens: 640, outputTokens: 120, totalTokens: 760, source: 'reported', rounds: 1 },
  },
]
let timer: ReturnType<typeof setInterval> | undefined
function change(next: string) {
  clearInterval(timer)
  mode.value = next
  activity.value = createChatActivity(Date.now() - 9400)
  updateChatActivity(activity.value, { agentRole: 'planner', phase: 'thinking', round: 1 })
  updateChatActivity(activity.value, { agentRole: 'worker', phase: 'tools', round: 2 })
  tools.value = [
    {
      id: 'read',
      label: 'file_read',
      detail: 'Chat-Komponenten im Projekt gelesen. Keine privaten Inhalte in dieser Vorschau.',
      status: 'done',
      capability: 'project.read',
      dataHandling: 'ephemeral',
    },
    {
      id: 'test',
      label: 'node.run',
      detail: 'Oberflächenprüfung für den Chatverlauf.',
      status: next === 'waiting' ? 'waiting' : next === 'failed' ? 'failed' : next === 'canceled' ? 'canceled' : 'done',
      capability: 'terminal.node',
      dataHandling: 'ephemeral',
    },
  ]
  if (next === 'waiting') {
    activity.value.status = 'waiting'
    content.value = ''
    return
  }
  updateChatActivity(activity.value, { agentRole: 'reviewer', phase: 'receiving', round: 3 })
  if (next === 'running') {
    content.value = ''
    timer = setInterval(() => {
      content.value = result.slice(0, content.value.length + 7)
      if (content.value === result) {
        clearInterval(timer)
        mode.value = 'done'
        finishChatActivity(activity.value, 'done')
      }
    }, 160)
  } else {
    content.value = result
    finishChatActivity(activity.value, next as 'done' | 'failed' | 'canceled')
  }
}
change('done')
onBeforeUnmount(() => clearInterval(timer))
const running = computed(() => mode.value === 'running' || mode.value === 'waiting')
const snapshot = computed(() => ({
  ...emptyMiniSnapshot(),
  sessionId: 'design-review',
  view: 'chat' as const,
  busy: running.value,
  project: { id: 'preview', name: 'Designvorschau' },
  messages: [
    {
      id: 'preview-answer',
      role: 'assistant' as const,
      content: content.value,
      createdAt: Date.now() - 10000,
      choices: [],
      status: running.value ? ('running' as const) : (mode.value as 'done' | 'canceled' | 'failed'),
      activity: activity.value,
      commentary,
    },
  ],
  appearance: { ...emptyMiniSnapshot().appearance, assistantName: 'Luczor' },
}))
</script>
<template>
  <main class="review" :class="{ 'is-narrow': narrow }">
    <aside class="review-controls">
      <strong>Chat · Designprüfung</strong><small>Synthetische Vorschau · keine Modellanfrage</small>
      <button
        v-for="item in [
          { id: 'done', label: 'Abgeschlossen' },
          { id: 'running', label: 'Stream starten' },
          { id: 'waiting', label: 'Freigabe offen' },
          { id: 'failed', label: 'Fehler' },
          { id: 'canceled', label: 'Abbruch' },
        ]"
        :key="item.id"
        @click="change(item.id)"
      >
        {{ item.label }}
      </button>
      <button :aria-pressed="narrow" @click="narrow = !narrow">390 px</button>
      <button :aria-pressed="showMini" @click="showMini = !showMini">Mini-Chat</button>
    </aside>
    <section class="review-chat">
      <header class="review-header">
        <span><AiIcon /> Luczor <small>Chatverlauf</small></span
        ><span class="review-live">{{ running ? 'Aktive Aufgabe' : 'Designvorschau' }}</span>
      </header>
      <ChatComposer>
        <article class="ai-message ai-message--user">
          <header><strong>Du</strong><time>14:32</time></header>
          <p class="ai-message__user-text">{{ message }}</p>
        </article>
        <article class="ai-message ai-message--assistant" :class="{ 'is-running': running }">
          <header>
            <span class="ai-message__avatar"><AiIcon :size="15" /></span><strong>Luczor</strong><time>14:32</time
            ><span class="ai-message__model">Lokales Modell</span>
          </header>
          <ChatAgentRoster :activity="activity" :loading="running" />
          <ThinkingState
            :steps="activity.steps"
            :status="activity.status"
            :active="running"
            :label="activityLabel(activity, mode === 'waiting')"
            :started-at="activity.startedAt"
            :duration-ms="activity.finishedAt ? activity.finishedAt - activity.startedAt : undefined"
          />
          <ToolChips :tools="tools" />
          <ChatCommentary :entries="commentary" :active="running" message-id="preview-answer" />
          <StreamingText
            v-if="content"
            :content="content"
            :streaming="running"
            :show-stream-status="false"
            :speech-disabled="true"
            speech-disabled-reason="Synthetische Vorschau"
            :follow-ups="
              mode === 'done' ? ['Die Agentenrollen genauer ansehen', 'Als Nächstes den Mini-Chat prüfen'] : []
            "
          />
          <AgentTeamResults v-if="mode === 'done'" :outcomes="outcomes" />
        </article>
      </ChatComposer>
      <div class="review-composer">
        <PromptBar v-model="draft" :busy="running" model-label="Lokales Modell" @stop="change('canceled')" />
      </div>
    </section>
    <MiniChatSurface
      v-if="showMini"
      :snapshot="snapshot"
      @action="event => (event.type === 'stop' ? change('canceled') : undefined)"
    />
  </main>
</template>
<style scoped src="../../src/styles/ai-workspace.css"></style>
<style scoped>
.review {
  height: 100dvh;
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  background: var(--ai-page);
  color: var(--ai-ink);
  font-family: var(--ai-font);
}
.review-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 28px 16px;
  border-right: 1px solid var(--ai-line);
  font-size: 13px;
}
.review-controls small {
  font-size: 10px;
  color: var(--ai-faint);
  line-height: 1.6;
  margin-bottom: 20px;
}
.review-controls button {
  background: var(--ai-canvas);
  border: 1px solid var(--ai-line);
  color: var(--ai-muted);
  border-radius: 6px;
  padding: 8px;
  text-align: left;
  font-size: 12px;
}
.review-chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  max-width: 1100px;
  width: 100%;
  margin-inline: auto;
}
.review.is-narrow .review-chat {
  width: 390px;
  border-inline: 1px solid var(--ai-line);
}
.review-header {
  height: 65px;
  padding: 0 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--ai-line);
  font-size: 13px;
  flex-shrink: 0;
}
.review-header > span {
  display: flex;
  align-items: center;
  gap: 10px;
}
.review-header small,
.review-live {
  font-size: 10px;
  color: var(--ai-faint);
}
.review-composer {
  padding: 12px 24px 20px;
}
.review :deep(.ai-thread) {
  padding-top: 10px;
}
@media (max-width: 600px) {
  .review {
    grid-template-columns: minmax(0, 1fr);
  }
  .review-controls {
    flex-direction: row;
    flex-wrap: wrap;
    padding: 8px;
  }
  .review-controls strong,
  .review-controls small {
    display: none;
  }
  .review-controls button {
    font-size: 10px;
  }
  .review-chat {
    min-height: 0;
  }
  .review {
    grid-template-rows: auto minmax(0, 1fr);
  }
  .review :deep(.ai-chat__messages) {
    padding: 24px 16px;
  }
  .review-composer {
    padding: 10px;
  }
}
</style>
