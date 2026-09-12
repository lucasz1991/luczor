<script setup lang="ts">
import { computed } from 'vue'
import type { ChatActivity } from '@/services/chatActivity'
import { presentChatAgents } from '@/services/chatAgentPresentation'
import AiIcon from './AiIcon.vue'

const props = defineProps<{ activity?: ChatActivity; loading?: boolean; waiting?: boolean }>()
const agents = computed(() => presentChatAgents(props.activity, props.loading, props.waiting))
</script>

<template>
  <section v-if="agents.length" class="chat-agents" aria-label="Agenten in dieser Antwort">
    <div class="chat-agents__heading">
      <span>Agenten</span><span class="chat-agents__count">{{ agents.length }} beteiligt</span>
    </div>
    <ul class="chat-agents__list">
      <li v-for="agent in agents" :key="agent.role" class="chat-agent" :data-status="agent.status">
        <span class="chat-agent__mark"><AiIcon :name="agent.icon" :size="15" /></span>
        <div class="chat-agent__body">
          <div class="chat-agent__identity">
            <strong>{{ agent.label }}</strong>
            <span class="chat-agent__status">
              <AiIcon v-if="agent.status === 'done'" name="check" :size="11" />
              <AiIcon v-else-if="agent.status === 'failed' || agent.status === 'canceled'" name="close" :size="11" />
              <span v-else-if="agent.status === 'running'" class="chat-agent__pulse" aria-hidden="true" />
              {{ agent.statusLabel }}
            </span>
          </div>
          <p class="chat-agent__phase" :title="agent.detail">
            <span v-if="agent.status !== 'running' && agent.status !== 'waiting'" class="ai-sr-only"
              >Letzter Schritt: </span
            >{{ agent.phase }}
          </p>
          <small v-if="agent.model || agent.provider" class="chat-agent__model">{{
            [agent.provider, agent.model].filter(Boolean).join(' · ')
          }}</small>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.chat-agents {
  margin-block: 16px;
  color: var(--ai-muted);
  font: 12px/1.5 var(--ai-font);
  container-type: inline-size;
}
.chat-agents__heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
  font-size: 11px;
  font-weight: 550;
}
.chat-agents__count {
  color: var(--ai-faint);
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}
.chat-agents__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.chat-agent {
  display: flex;
  flex: 1 1 180px;
  align-items: flex-start;
  gap: 9px;
  min-width: 0;
  padding-block: 6px;
}
.chat-agent__mark {
  display: grid;
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 7px;
  color: var(--ai-muted);
  background: color-mix(in srgb, var(--ai-ink) 4%, transparent);
}
.chat-agent__body {
  min-width: 0;
  flex: 1;
}
.chat-agent__identity {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px 10px;
  min-height: 20px;
}
.chat-agent__identity strong {
  color: var(--ai-ink);
  font-weight: 550;
}
.chat-agent__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ai-faint);
  font-size: 10px;
}
.chat-agent__phase {
  margin: 2px 0 0;
  overflow-wrap: anywhere;
  font-size: 11px;
}
.chat-agent__model {
  display: block;
  margin-top: 3px;
  color: var(--ai-faint);
  font-size: 10px;
  overflow-wrap: anywhere;
}
.chat-agent[data-status='running'] .chat-agent__mark {
  background: color-mix(in srgb, var(--ai-accent) 9%, transparent);
  color: var(--ai-accent);
}
.chat-agent[data-status='running'] .chat-agent__status {
  color: var(--ai-accent);
}
.chat-agent[data-status='failed'] .chat-agent__status {
  color: var(--ai-red);
}
.chat-agent[data-status='waiting'] .chat-agent__status {
  color: var(--ai-orange);
}
.chat-agent__pulse {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: agent-breathe 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
@keyframes agent-breathe {
  50% {
    opacity: 0.35;
  }
}
@container (max-width: 460px) {
  .chat-agents__list {
    gap: 3px;
  }
  .chat-agent {
    flex-basis: 100%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chat-agent__pulse {
    animation: none;
  }
}
:global(html[data-reduce-motion='1'] .chat-agent__pulse),
:global([data-reduce-motion='true'] .chat-agent__pulse) {
  animation: none;
}
</style>
