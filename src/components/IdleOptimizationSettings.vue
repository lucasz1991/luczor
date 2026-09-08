<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  idleOptimizationEnabled,
  idleOptimizationStatus,
  saveIdleOptimizationSetting,
} from '@/services/agents/idleOptimization'
const saving = ref(false)
const error = ref('')
const reason = computed(() => {
  const state = idleOptimizationStatus.value
  if (!idleOptimizationEnabled.value) return 'Ausgeschaltet'
  if (state?.phase === 'running') return 'Prüft lokalen Kontext'
  if (state?.phase === 'committing') return 'Speichert den lokalen Optimierungsvorschlag'
  if (state?.phase === 'yielding') return 'Gibt das Modell für deinen Auftrag frei'
  if (state?.reason === 'memory_pressure') return 'Pausiert: zu wenig freier Arbeitsspeicher'
  if (state?.reason === 'memory_disabled') return 'Pausiert: automatische Erinnerungen sind ausgeschaltet'
  if (state?.reason === 'runtime_unavailable') return 'Wartet auf ein einsatzbereites lokales Modell'
  if (state?.reason === 'candidate_ready') return 'Optimierungsvorschlag in den Erinnerungen gespeichert'
  if (state?.reason === 'failed' || state?.reason === 'timeout') return 'Pausiert nach einer unvollständigen Prüfung'
  if (state?.reason === 'unchanged_context') return 'Kontext unverändert – keine erneute Prüfung nötig'
  if (state?.reason === 'native_required') return 'In der Desktop-App verfügbar'
  return 'Wartet auf Leerlauf'
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
    <p class="lz-hint">
      Nach 45 Sekunden Ruhe, höchstens eine Minute je Prüfung. Nur auf diesem Gerät; Vorschläge bleiben unbestätigt und
      verändern keine bestehenden Fakten. Bei Speicherdruck pausiert die Arbeit.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
