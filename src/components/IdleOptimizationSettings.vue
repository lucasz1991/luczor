<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  idleOptimizationEnabled,
  idleOptimizationStatus,
  idleMemoryMaintenance,
  idleRepositoryStatus,
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
    return state.task === 'repository'
      ? 'Analysiert den lokalen Repository-Graphen'
      : state.task === 'memory'
        ? 'Analysiert Erinnerungen aus lokalem Speicher, SQL und Cognee'
        : 'Optimiert den Projektkontext'
  if (state?.phase === 'committing')
    return state.task === 'memory' ? 'Speichert die KI-Erinnerung dauerhaft' : 'Speichert den KI-Kontext dauerhaft'
  if (state?.phase === 'yielding') return 'Gibt das Modell für deinen Auftrag frei'
  if (state?.reason === 'manual_requested') return 'Prüfung wird jetzt vorbereitet'
  if (state?.reason === 'memory_pressure') return 'Pausiert: zu wenig freier Arbeitsspeicher'
  if (state?.reason === 'memory_disabled') return 'Pausiert: automatische Erinnerungen sind ausgeschaltet'
  if (state?.reason === 'runtime_unavailable') return 'Wartet auf ein einsatzbereites lokales Modell'
  if (state?.reason === 'candidate_ready') return 'KI-Ergebnis automatisch als aktive Erinnerung gespeichert'
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
          Die lokale KI prüft Projektkontext, den lokalen Repository-Graphen und erreichbare Erinnerungen einschließlich
          SQL und Cognee. Dein nächster Chat hat Vorrang.
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
        · {{ idleOptimizationStatus.completed }} automatisch gespeicherte Ergebnisse in dieser Sitzung</template
      >
    </p>
    <p v-if="idleMemoryMaintenance !== 'idle'" class="lz-hint" role="status">
      {{
        idleMemoryMaintenance === 'scheduled'
          ? 'Cognee: Serveroptimierung eingereiht; Abschluss noch nicht bestätigt.'
          : idleMemoryMaintenance === 'not_scheduled'
            ? 'Cognee: Kein neuer Auftrag eingereiht (laufender Auftrag, Wartezeit oder deaktiviert).'
            : 'Cognee: Serveroptimierung aktuell nicht erreichbar oder nicht freigegeben.'
      }}
    </p>
    <p class="lz-hint">
      Repository: {{ idleRepositoryStatus }}. Die KI verwendet den aktuellen lokalen Index und belegte Quellausschnitte.
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
      Nach 10 Minuten ohne Eingabe läuft die Hintergrundarbeit ohne Gesamtlaufzeitlimit in einzelnen KI-Prüfungen
      weiter. Neue Themen folgen automatisch; unveränderte Daten werden regelmäßig erneut auf Änderungen geprüft. Ein
      Chat stoppt die lokale KI-Prüfung und erhält das Modell nach dessen Freigabe. Danach beginnt die Leerlaufzeit neu.
      Die Servereinstellung für Erinnerungen gilt weiterhin. KI-Ergebnisse werden ohne Einzelbestätigung dauerhaft als
      aktive, private Erinnerungen auf diesem Gerät gespeichert. KI-Herkunft und Unsicherheit bleiben gekennzeichnet;
      bestehende Erinnerungen werden nicht überschrieben. Automatische Erinnerungen müssen eingeschaltet sein. Cognee
      optimiert seine vorhandenen Serverdaten separat; ein eingereihter Serverauftrag läuft unabhängig vom lokalen Chat.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
