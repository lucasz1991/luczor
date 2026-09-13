<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { modelSwitchIsPending, type ModelSwitchState } from '@/services/inference/modelSwitch'

const props = defineProps<{ state: ModelSwitchState; modelNames: Record<string, string> }>()
const emit = defineEmits<{ retry: [] }>()
const dismissed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
const pending = computed(() => modelSwitchIsPending(props.state))
const title = computed(
  () =>
    ({
      idle: '',
      waiting: 'Modellwechsel vorgemerkt',
      unloading: 'Vorheriges Modell wird entladen',
      loading: 'Neues Modell wird vorbereitet',
      ready: 'Lokales Modell ist bereit',
      failed: 'Modellwechsel fehlgeschlagen',
    })[props.state.phase]
)
const name = (id: string | null | undefined) =>
  id ? (Object.entries(props.modelNames).find(([modelId]) => modelId === id)?.[1] ?? id) : 'Automatische Modellwahl'
watch(
  () => [props.state.revision, props.state.phase],
  () => {
    dismissed.value = false
    if (timer) clearTimeout(timer)
    if (props.state.phase === 'ready')
      timer = setTimeout(() => {
        dismissed.value = true
      }, 8_000)
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <aside
    v-if="state.phase !== 'idle' && !dismissed"
    class="model-switch-alert"
    role="status"
    aria-live="polite"
    :aria-busy="pending"
  >
    <div class="model-switch-alert__heading">
      <span
        class="model-switch-alert__marker"
        :class="{ 'is-pending': pending, 'is-failed': state.phase === 'failed' }"
        aria-hidden="true"
      ></span>
      <strong>{{ title }}</strong>
      <button
        v-if="!pending"
        type="button"
        class="model-switch-alert__close"
        aria-label="Modellwechsel-Anzeige schließen"
        @click="dismissed = true"
      >
        ×
      </button>
    </div>
    <p class="model-switch-alert__model">{{ name(state.activeModelId ?? state.selectedModelId) }}</p>
    <p v-if="state.phase === 'waiting'">
      Laufende Aufträge werden abgeschlossen. Neue Chats warten auf die Modellvorbereitung.
    </p>
    <ol v-else-if="state.phase !== 'failed'">
      <li :class="{ 'is-complete': state.phase === 'loading' || state.phase === 'ready' }">
        {{ state.previousModelId ? name(state.previousModelId) : 'Vorheriges Modell' }}: Runtime beenden · RAM/GPU
        freigeben
      </li>
      <li :class="{ 'is-complete': state.phase === 'ready' }">Neues Modell laden und Bereitschaft prüfen</li>
    </ol>
    <p v-if="state.phase === 'loading'">Neue Chats zeigen „Modell vorbereiten“ und starten nach der Prüfung.</p>
    <template v-if="state.phase === 'failed'">
      <p>Die Bereitschaft wurde nicht bestätigt. Details stehen unter Systemstatus → Lokales Modell.</p>
      <button type="button" class="model-switch-alert__retry" @click="emit('retry')">Erneut vorbereiten</button>
    </template>
  </aside>
</template>

<style scoped>
.model-switch-alert {
  position: fixed;
  top: 1rem;
  right: 1rem;
  z-index: 10000;
  width: min(25rem, calc(100vw - 2rem));
  padding: 1rem;
  border: 1px solid var(--border, #3b424c);
  border-radius: 12px;
  background: var(--panel, #1d2026);
  color: var(--text, #e9edf3);
  box-shadow: 0 10px 32px #0004;
  font-size: 0.82rem;
  line-height: 1.5;
}
.model-switch-alert__heading {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.model-switch-alert__marker {
  width: 0.65rem;
  height: 0.65rem;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #6ac6aa;
}
.model-switch-alert__marker.is-pending {
  background: transparent;
  border: 2px solid #70c9dc44;
  border-top-color: #70c9dc;
  animation: model-switch-spin 1s linear infinite;
}
.model-switch-alert__marker.is-failed {
  background: #ed8b8b;
}
.model-switch-alert__close {
  margin-left: auto;
  background: transparent;
  color: inherit;
  border: 0;
  cursor: pointer;
  font-size: 1.25rem;
}
.model-switch-alert__model {
  color: var(--muted, #aeb7c5);
  margin: 0.4rem 0 0.65rem;
}
.model-switch-alert p {
  margin-bottom: 0;
}
.model-switch-alert ol {
  padding-left: 1.2rem;
  margin: 0.6rem 0;
  color: var(--muted, #aeb7c5);
}
.model-switch-alert li + li {
  margin-top: 0.35rem;
}
.model-switch-alert li.is-complete {
  color: #8cd2b9;
}
.model-switch-alert__retry {
  margin-top: 0.7rem;
  padding: 0.35rem 0.65rem;
  border-radius: 6px;
  border: 1px solid var(--border, #3b424c);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.model-switch-alert button:focus-visible {
  outline: 2px solid #70c9dc;
  outline-offset: 3px;
}
@keyframes model-switch-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .model-switch-alert__marker.is-pending {
    animation: none;
  }
}
</style>
