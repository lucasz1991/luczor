<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { readLocalModelStatus, type LocalModelStatusView } from '@/services/localModelStatus'

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const status = ref<LocalModelStatusView | null>(null)
const refreshing = ref(false)
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0

async function refresh() {
  if (!props.active || refreshing.value) return
  if (refreshTimer) clearTimeout(refreshTimer)
  const current = generation
  refreshing.value = true
  const next = await readLocalModelStatus()
  if (current !== generation || !props.active) return
  status.value = next
  refreshing.value = false
  refreshTimer = setTimeout(() => void refresh(), 3_000)
}

watch(
  () => props.active,
  active => {
    generation += 1
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshing.value = false
    status.value = null
    if (active) void refresh()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  generation += 1
  if (refreshTimer) clearTimeout(refreshTimer)
})
</script>

<template>
  <section class="local-model-status" aria-label="Lokales Modell" :data-state="status?.state ?? 'loading'">
    <div class="local-model-status__heading">
      <strong>{{ status?.modelName ?? 'Lokales Modell' }}</strong>
      <button type="button" :disabled="refreshing" @click="refresh">
        {{ refreshing ? 'Prüft …' : 'Aktualisieren' }}
      </button>
    </div>
    <p class="local-model-status__label" role="status" aria-live="polite">
      {{ status?.label ?? 'Modellstatus wird gelesen …' }}
    </p>
    <p v-if="status" class="local-model-status__detail">{{ status.detail }}</p>
    <div v-if="status" class="local-model-status__readiness">
      <span
        >Vorbereitet: <b>{{ status.prepared ? 'Ja' : 'Nicht bestätigt' }}</b></span
      >
      <span
        >Einsatzbereit: <b>{{ status.operational ? 'Ja' : 'Nicht bestätigt' }}</b></span
      >
    </div>
    <details v-if="status?.checks.length" class="local-model-status__checks">
      <summary>Prüfdetails</summary>
      <dl>
        <div v-for="check in status.checks" :key="check.label" :data-verified="check.verified">
          <dt>{{ check.label }}</dt>
          <dd>{{ check.value }}</dd>
        </div>
      </dl>
    </details>
    <small v-if="status"
      >Stand {{ new Date(status.checkedAtMs).toLocaleTimeString('de-DE') }} · aktualisiert automatisch</small
    >
  </section>
</template>

<style scoped>
.local-model-status {
  display: grid;
  gap: 10px;
  padding: 16px 0;
  border-top: 1px solid var(--border-soft);
  color: var(--text-primary);
  font-size: 12px;
}
.local-model-status__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.local-model-status__heading strong {
  overflow-wrap: anywhere;
  font-size: 13px;
}
.local-model-status button {
  padding: 6px 8px;
  border: 1px solid var(--border-soft);
  border-radius: 5px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font: inherit;
}
.local-model-status button:disabled {
  opacity: 0.6;
  cursor: wait;
}
.local-model-status button:focus-visible,
.local-model-status summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.local-model-status p {
  margin: 0;
  line-height: 1.5;
}
.local-model-status__label {
  font-weight: 600;
}
.local-model-status[data-state='ready'] .local-model-status__label,
.local-model-status[data-state='busy'] .local-model-status__label {
  color: var(--success, #81cba1);
}
.local-model-status[data-state='error'] .local-model-status__label {
  color: var(--danger, #ee9292);
}
.local-model-status__detail,
.local-model-status small,
.local-model-status dt {
  color: var(--text-muted);
}
.local-model-status__readiness {
  display: grid;
  gap: 5px;
}
.local-model-status__readiness b {
  font-weight: 500;
}
.local-model-status summary {
  cursor: pointer;
  padding: 4px 0;
}
.local-model-status dl {
  display: grid;
  gap: 9px;
  margin: 10px 0 0;
}
.local-model-status dl > div {
  display: grid;
  gap: 3px;
}
.local-model-status dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
