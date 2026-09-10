<script setup lang="ts">
import AiIcon from '@/components/ai/AiIcon.vue'
import type { ToolSession } from '@/services/tools/toolSessionCoordinator'

defineProps<{ sessions: readonly ToolSession[] }>()
const emit = defineEmits<{ (event: 'stop', id: string): void }>()
</script>

<template>
  <section class="tool-run-inspector" aria-labelledby="tool-run-title">
    <div class="tool-section-heading">
      <span><AiIcon name="activity" :size="14" /> Laufende Sitzungen</span><small>{{ sessions.length }}</small>
    </div>
    <p v-if="!sessions.length" class="tool-empty">Keine aktiven Browser-, Vision- oder Terminal-Sitzungen.</p>
    <article v-for="session in sessions" :key="session.id" class="tool-run-row">
      <div>
        <strong>{{ session.kind }}</strong
        ><small>{{ session.projectId }} · {{ session.id.slice(0, 8) }}</small>
      </div>
      <button type="button" class="tool-stop" @click="emit('stop', session.id)">Stop</button>
    </article>
  </section>
</template>
