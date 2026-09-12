<script setup lang="ts">
import { computed } from 'vue'
import type { ChatCommentary } from '@/state/types'
import type { ChatActivity } from '@/services/chatActivity'
import { publicActivityLabel } from '@/services/chatActivity'
import type { ActivityStep } from './types'
import { statusLabels } from './types'
import { activityStatusIcon } from './toolPresentation'
import AiIcon from './AiIcon.vue'
import ChatCommentaryView from './ChatCommentary.vue'
import ToolChips from './ToolChips.vue'

const props = withDefaults(
  defineProps<{ activity?: ChatActivity; commentary?: ChatCommentary[]; tools?: ActivityStep[]; active?: boolean }>(),
  { activity: undefined, commentary: () => [], tools: () => [], active: false }
)

type TimelineItem =
  | { id: string; kind: 'activity'; at: number; order: number; step: ActivityStep }
  | { id: string; kind: 'commentary'; at: number; order: number; entry: ChatCommentary }
  | { id: string; kind: 'tool'; at: number; order: number; tool: ActivityStep }

const agentLabels = {
  planner: 'Planung',
  worker: 'Bearbeitung',
  reviewer: 'Prüfung',
} as const
const agentIcons = { planner: 'grid', worker: 'tool', reviewer: 'shield' } as const

const entries = computed<TimelineItem[]>(() => {
  const fallback = props.activity?.startedAt ?? 0
  const activity = (props.activity?.steps ?? []).map((step, index) => ({
    id: `activity:${step.id}`,
    kind: 'activity' as const,
    at: step.createdAt ?? fallback + index,
    order: index,
    step,
  }))
  const commentary = props.commentary.map((entry, index) => ({
    id: `commentary:${entry.id}`,
    kind: 'commentary' as const,
    at: entry.createdAt,
    order: 1000 + index,
    entry,
  }))
  const tools = props.tools.map((tool, index) => ({
    id: `tool:${tool.id}`,
    kind: 'tool' as const,
    at: tool.createdAt ?? fallback + 2000 + index,
    order: 2000 + index,
    tool,
  }))
  return [...activity, ...commentary, ...tools].sort((left, right) => left.at - right.at || left.order - right.order)
})

function activityIcon(step: ActivityStep): string {
  return step.agentRole ? agentIcons[step.agentRole] : activityStatusIcon(step.status)
}
function isLatestCommentary(entry: ChatCommentary): boolean {
  return props.commentary.at(-1)?.id === entry.id
}
</script>

<template>
  <section v-if="entries.length" class="chat-turn-timeline" aria-label="Verlauf dieses Arbeitsgangs">
    <ol>
      <li v-for="item in entries" :key="item.id" :data-kind="item.kind">
        <div v-if="item.kind === 'activity'" class="chat-turn-timeline__activity" :data-status="item.step.status">
          <span class="chat-turn-timeline__mark" aria-hidden="true">
            <span v-if="item.step.status === 'running'" class="chat-turn-timeline__pulse" />
            <AiIcon v-else :name="activityIcon(item.step)" :size="13" />
          </span>
          <span class="chat-turn-timeline__copy">
            <strong v-if="item.step.agentRole">{{ agentLabels[item.step.agentRole] }}</strong>
            <span>{{ publicActivityLabel(item.step.label) }}</span>
            <small v-if="item.step.detail">{{ item.step.detail }}</small>
          </span>
          <span class="chat-turn-timeline__status">{{ statusLabels[item.step.status] }}</span>
        </div>
        <ChatCommentaryView
          v-else-if="item.kind === 'commentary'"
          :entries="[item.entry]"
          :active="active && isLatestCommentary(item.entry)"
          compact
        />
        <ToolChips v-else :tools="[item.tool]" />
      </li>
    </ol>
  </section>
</template>

<style scoped>
.chat-turn-timeline {
  margin: 12px 0 18px;
  font: 12px/1.5 var(--ai-font);
}
ol {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.chat-turn-timeline__activity {
  --timeline-tone: var(--ai-faint);
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  min-height: 34px;
  padding: 6px 10px;
  border-radius: 7px;
  color: var(--ai-muted);
}
.chat-turn-timeline__activity[data-status='running'] {
  --timeline-tone: var(--ai-accent);
  background: color-mix(in srgb, var(--ai-accent) 5%, transparent);
}
.chat-turn-timeline__activity[data-status='waiting'] {
  --timeline-tone: var(--ai-orange);
}
.chat-turn-timeline__activity[data-status='failed'] {
  --timeline-tone: var(--ai-red);
}
.chat-turn-timeline__activity[data-status='done'] {
  --timeline-tone: var(--ai-green);
}
.chat-turn-timeline__mark {
  display: grid;
  width: 18px;
  height: 20px;
  place-items: center;
  color: var(--timeline-tone);
}
.chat-turn-timeline__pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent);
  animation: timeline-pulse 1.35s ease-out infinite;
}
.chat-turn-timeline__copy {
  display: grid;
  min-width: 0;
  gap: 1px;
}
.chat-turn-timeline__copy strong {
  color: var(--ai-ink);
  font-size: 11px;
  font-weight: 550;
}
.chat-turn-timeline__copy span {
  overflow-wrap: anywhere;
}
.chat-turn-timeline__copy small,
.chat-turn-timeline__status {
  color: var(--ai-faint);
  font-size: 10px;
}
.chat-turn-timeline__status {
  padding-top: 2px;
  color: var(--timeline-tone);
  white-space: nowrap;
}
@keyframes timeline-pulse {
  70% {
    box-shadow: 0 0 0 7px color-mix(in srgb, currentColor 0%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 0%, transparent);
  }
}
@media (prefers-reduced-motion: reduce) {
  .chat-turn-timeline__pulse {
    animation: none;
  }
}
:global(html[data-reduce-motion='1']) .chat-turn-timeline__pulse {
  animation: none;
}
</style>
