<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  idleOptimizationEnabled,
  idleOptimizationStatus,
  requestIdleOptimization,
  saveIdleOptimizationSetting,
} from '@/services/agents/idleOptimization'
import { maintenanceProgress } from '@/services/agents/idleMaintenanceWorker'
import { luczorMemory } from '@/services/memory/luczorMemory'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
const consent = ref({ installedModelStart: false, automaticRewrite: false })
const consentPrincipal = ref('')
const quality = ref('Noch nicht geprüft')
const stageLabels: Record<string, string> = {
  idle: 'Wartet',
  preparing: 'Modellstart',
  generating: 'KI verarbeitet',
  verifying: 'KI prüft',
  committing: 'Speichert',
  indexing: 'Indexiert',
  paused: 'Pausiert',
}
const qualityLabels: Record<string, string> = {
  not_evaluated: 'Modelltest fehlt',
  passed: 'Modelltest bestanden',
  evaluation_running: 'Modelltest läuft',
  quality_regression: 'Qualitätsprüfung nicht bestanden',
  review_failure: 'Umschreiben nach Prüfverletzung pausiert',
}
async function loadConsent() {
  consentPrincipal.value = ''
  consent.value = { installedModelStart: false, automaticRewrite: false }
  try {
    const account = await getVerifiedAccountSnapshot()
    if (!account) return
    const snapshot = await luczorMemory.maintenanceSnapshot(account.principalId)
    consentPrincipal.value = account.principalId
    consent.value = snapshot.journal.consent ?? consent.value
    quality.value = snapshot.journal.quality?.passed
      ? 'Bestanden für das geprüfte Modell'
      : 'Umschreiben gesperrt bis zur Modellprüfung'
  } catch {
    quality.value = 'Konto oder Speicher nicht verfügbar'
  }
}
function clearConsent() {
  consentPrincipal.value = ''
  consent.value = { installedModelStart: false, automaticRewrite: false }
  quality.value = 'Konto wird gewechselt'
}
async function saveConsent() {
  error.value = ''
  try {
    if (!consentPrincipal.value) throw new Error('account_required')
    await luczorMemory.updateMaintenance(consentPrincipal.value, journal => {
      journal.consent = { ...consent.value }
    })
  } catch {
    error.value = 'Freigabe konnte nicht gespeichert werden. Konto erneut prüfen.'
    await loadConsent()
  }
}
async function evaluate() {
  try {
    if (!consentPrincipal.value) throw new Error('account_required')
    await luczorMemory.updateMaintenance(consentPrincipal.value, journal => {
      journal.evaluationRequested = Date.now()
      journal.evaluations = []
      journal.quality = undefined
    })
    quality.value = 'Prüflauf angefordert – benötigt ein lokales Modell'
    startNow()
  } catch {
    error.value = 'Prüflauf konnte nicht angefordert werden.'
  }
}
const saving = ref(false)
const error = ref('')
const requesting = ref(false)
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  void loadConsent()
  window.addEventListener('luczor:api-identity-changed', loadConsent)
  window.addEventListener('luczor:api-identity-changing', clearConsent)
  clock = setInterval(() => {
    now.value = Date.now()
  }, 1_000)
})
onBeforeUnmount(() => {
  window.removeEventListener('luczor:api-identity-changed', loadConsent)
  window.removeEventListener('luczor:api-identity-changing', clearConsent)
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
  if (state?.reason === 'candidate_ready') return 'Geprüftes Ergebnis automatisch gespeichert'
  if (state?.reason === 'model_start_consent_required') return 'Wartet auf Modell oder kontobezogene Startfreigabe'
  if (state?.reason === 'failed' || state?.reason === 'timeout') return 'Pausiert nach einer unvollständigen Prüfung'
  if (state?.reason === 'unchanged_context') return 'Kontext unverändert – keine erneute Prüfung nötig'
  if (state?.reason === 'native_required') return 'In der Desktop-App verfügbar'
  if (state?.reason === 'no_context')
    return 'Kein ausführbarer Auftrag – unveränderte Quellen werden nicht erneut bearbeitet'
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
    <p class="lz-hint" role="status">Cognee: {{ maintenanceProgress.provider }}.</p>
    <p class="lz-hint">
      Repository: {{ maintenanceProgress.repository }}. Architekturpakete verwenden belegte Datei- und Symbolreferenzen.
    </p>
    <div class="maintenance-consent">
      <label
        ><input
          v-model="consent.installedModelStart"
          type="checkbox"
          :disabled="!consentPrincipal"
          @change="saveConsent"
        />
        Installiertes lokales Modell im Leerlauf starten (nur dieses Konto)</label
      >
      <label
        ><input
          v-model="consent.automaticRewrite"
          type="checkbox"
          :disabled="!consentPrincipal"
          @change="saveConsent"
        />
        Geprüfte Erinnerungsänderungen automatisch speichern; Umschreiben erst nach bestandenem Modelltest</label
      >
    </div>
    <p class="lz-hint" role="status">
      {{ stageLabels[maintenanceProgress.stage] ?? maintenanceProgress.stage }} ·
      {{ maintenanceProgress.queued }} wartend · {{ maintenanceProgress.checked }} Quellen geprüft ·
      {{ maintenanceProgress.changed }} Änderungen · {{ maintenanceProgress.conflicts }} Konflikte ·
      {{ maintenanceProgress.blocked }} blockiert
      <template v-if="maintenanceProgress.modelId"> · Modell {{ maintenanceProgress.modelId }}</template>
    </p>
    <p class="lz-hint">{{ quality }} · {{ qualityLabels[maintenanceProgress.quality] ?? 'Prüfung ausstehend' }}</p>
    <button
      type="button"
      class="lz-btn lz-btn--ghost"
      :disabled="!consentPrincipal || !idleOptimizationEnabled"
      @click="evaluate"
    >
      Lokalen Qualitätstest anfordern
    </button>
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
      weiter. Geänderte Quellen erzeugen Aufträge; erledigte Revisionen bleiben über Neustarts erhalten. Ein Chat stoppt
      die lokale KI-Prüfung und erhält das Modell nach dessen Freigabe. Danach beginnt die Leerlaufzeit neu.
      Kontextpakete werden getrennt von Erinnerungen gespeichert. KI-Herkunft und Unsicherheit bleiben gekennzeichnet.
      Freigegebene Ersetzungen haben kein dauerhaftes Archiv des alten Volltexts und keine Text-Rücknahme. Automatische
      Erinnerungen müssen eingeschaltet sein. Cognee optimiert seine vorhandenen Serverdaten separat; ein eingereihter
      Serverauftrag läuft unabhängig vom lokalen Chat.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.maintenance-consent {
  display: grid;
  gap: 12px;
  font-size: 13px;
  line-height: 1.5;
}
.maintenance-consent label {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.maintenance-consent input {
  flex-shrink: 0;
  margin-top: 3px;
}
</style>
