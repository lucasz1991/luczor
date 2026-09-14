<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  idleOptimizationEnabled,
  idleOptimizationStatus,
  requestIdleOptimization,
  saveIdleOptimizationSetting,
} from '@/services/agents/idleOptimization'
const saving = ref(false)
const error = ref('')
const requesting = ref(false)
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 1_000)
})
onBeforeUnmount(() => {
  if (clock !== undefined) clearInterval(clock)
})

function formatRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} Min.`
}

const countdown = computed(() => {
  const nextCheckAt = idleOptimizationStatus.value?.nextCheckAt
  return nextCheckAt === null || nextCheckAt === undefined ? null : formatRemaining(nextCheckAt - now.value)
})
const reason = computed(() => {
  const state = idleOptimizationStatus.value
  if (!idleOptimizationEnabled.value) return 'Ausgeschaltet'
  if (state?.phase === 'running')
    return state.task === 'memory' ? 'Analysiert und ordnet lokale Erinnerungen' : 'Optimiert den Projektkontext'
  if (state?.phase === 'committing')
    return state.task === 'memory'
      ? 'Speichert den unbestätigten Erinnerungsvorschlag'
      : 'Speichert den unbestätigten Kontextvorschlag'
  if (state?.phase === 'yielding') return 'Gibt das Modell für deinen Auftrag frei'
  if (state?.reason === 'manual_requested') return 'Prüfung wird jetzt vorbereitet'
  if (state?.reason === 'memory_pressure') return 'Pausiert: zu wenig freier Arbeitsspeicher'
  if (state?.reason === 'memory_disabled') return 'Pausiert: automatische Erinnerungen sind ausgeschaltet'
  if (state?.reason === 'runtime_unavailable') return 'Wartet auf ein einsatzbereites lokales Modell'
  if (state?.reason === 'candidate_ready') return 'Optimierungsvorschlag in den Erinnerungen gespeichert'
  if (state?.reason === 'failed' || state?.reason === 'timeout') return 'Pausiert nach einer unvollständigen Prüfung'
  if (state?.reason === 'unchanged_context') return 'Kontext unverändert – keine erneute Prüfung nötig'
  if (state?.reason === 'native_required') return 'In der Desktop-App verfügbar'
  if (state?.reason === 'no_context') return 'Wartet auf Projektkontext oder bestätigte Erinnerungen'
  if (countdown.value) return `Nächste lokale Prüfung in ${countdown.value}`
  return 'Wartet auf 10 Minuten Leerlauf'
})
async function toggle() {
  saving.value = true
  error.value = ''
  try {
    await saveIdleOptimizationSetting(!idleOptimizationEnabled.value)
  } catch {
    error.value = 'Die Einstellung konnte nicht gespeichert werden.'
  } finally {
    saving.value = false
  }
}
function startNow() {
  error.value = ''
  requesting.value = true
  try {
    if (!requestIdleOptimization())
      error.value = 'Die Prüfung kann erst starten, wenn Luczor bereit ist und kein Auftrag läuft.'
  } finally {
    requesting.value = false
  }
}
</script>
<template>
  <div class="lz-card">
    <div class="lz-card__head">
      <div>
        <div class="lz-card__title">Kontext im Leerlauf optimieren</div>
        <p class="lz-hint">
          Lokale Agenten prüfen Erinnerungen und das aktive Projekt. Dein nächster Auftrag hat Vorrang.
        </p>
      </div>
      <button
        type="button"
        class="lz-switch"
        :class="{ 'is-on': idleOptimizationEnabled }"
        :aria-pressed="idleOptimizationEnabled"
        :disabled="saving"
        aria-label="Kontext im Leerlauf optimieren"
        @click="toggle"
      >
        <span />
      </button>
    </div>
    <p class="lz-hint" role="status">
      {{ reason
      }}<template v-if="idleOptimizationStatus?.completed">
        · {{ idleOptimizationStatus.completed }} Vorschläge in dieser Sitzung</template
      >
    </p>
    <button
      type="button"
      class="lz-btn lz-btn--ghost"
      :disabled="!idleOptimizationEnabled || saving || requesting"
      @click="startNow"
    >
      {{ requesting ? 'Startet…' : 'Nächste Prüfung jetzt starten' }}
    </button>
    <p class="lz-hint">
      Nach 10 Minuten ohne Eingabe optimiert Luczor abwechselnd Projektkontext und bestätigte Erinnerungen. Jede lokale
      Prüfung läuft höchstens eine Minute, gibt deinem Auftrag sofort Vorrang und verwendet keine Werkzeuge oder externe
      Modelle. Vorschläge bleiben unbestätigt und verändern keine bestehenden Fakten.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
