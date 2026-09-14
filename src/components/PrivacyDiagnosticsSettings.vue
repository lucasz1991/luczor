<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { clearDebugData, loadDebugCollectionEnabled, setDebugCollectionEnabled } from '@/services/debug'
import { traceEnabled, setTraceEnabled } from '@/services/debugTrace'

type StatusMessage = { ok: boolean; text: string }

const enabled = ref(false)
const detailed = ref(false)
const loaded = ref(false)
const busy = ref(false)
const status = ref<StatusMessage | null>(null)

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? `${fallback} ${error.message}` : fallback
}

async function loadPreference(): Promise<void> {
  busy.value = true
  status.value = null
  try {
    enabled.value = await loadDebugCollectionEnabled()
    detailed.value = await traceEnabled()
    loaded.value = true
  } catch (error) {
    enabled.value = false
    status.value = { ok: false, text: errorMessage(error, 'Die Diagnosefreigabe konnte nicht geladen werden.') }
  } finally {
    busy.value = false
  }
}

async function toggleDiagnostics(): Promise<void> {
  if (busy.value || !loaded.value) return
  const next = !enabled.value
  busy.value = true
  status.value = null
  try {
    await setDebugCollectionEnabled(next)
    enabled.value = next
    detailed.value = await traceEnabled()
    status.value = {
      ok: true,
      text: next
        ? 'Diagnose ist freigegeben. Berichte werden nur bei einer Admin-Anfrage übertragen; der Inhalt richtet sich nach der Chat-Diagnose unten.'
        : 'Diagnose ist ausgeschaltet. Vorhandene lokale Diagnosedaten bleiben bis zum Löschen erhalten.',
    }
  } catch (error) {
    status.value = { ok: false, text: errorMessage(error, 'Die Diagnosefreigabe konnte nicht gespeichert werden.') }
  } finally {
    busy.value = false
  }
}

async function clearDiagnostics(): Promise<void> {
  if (busy.value) return
  busy.value = true
  status.value = null
  try {
    await clearDebugData()
    status.value = { ok: true, text: 'Alle lokalen Diagnosedaten wurden gelöscht.' }
  } catch (error) {
    status.value = { ok: false, text: errorMessage(error, 'Die lokalen Diagnosedaten konnten nicht gelöscht werden.') }
  } finally {
    busy.value = false
  }
}

async function toggleDetailed(): Promise<void> {
  busy.value = true
  try {
    await setTraceEnabled(!detailed.value)
    detailed.value = !detailed.value
    status.value = {
      ok: true,
      text: detailed.value
        ? 'Ausführliche Chat-Diagnose ab jetzt aktiv. Übertragung nur auf Admin-Anforderung.'
        : 'Ausführliche Chat-Diagnose ausgeschaltet.',
    }
  } catch (error) {
    status.value = { ok: false, text: errorMessage(error, 'Chat-Diagnose konnte nicht gespeichert werden.') }
  } finally {
    busy.value = false
  }
}

onMounted(() => void loadPreference())
</script>

<template>
  <div class="privacy-stack">
    <section class="privacy-card" aria-labelledby="diagnostics-title">
      <div class="privacy-card__head">
        <div>
          <h4 id="diagnostics-title">Optionale Diagnosefreigabe</h4>
          <p>
            Standardmäßig aus. Erst nach deiner Freigabe speichert Luczor minimierte Fehlerereignisse und beantwortet
            Diagnoseanfragen der Administration.
          </p>
        </div>
        <button
          type="button"
          class="privacy-switch"
          :class="{ 'is-on': enabled }"
          role="switch"
          :aria-checked="enabled"
          :aria-label="enabled ? 'Diagnosefreigabe ausschalten' : 'Diagnosefreigabe einschalten'"
          :disabled="busy || !loaded"
          @click="toggleDiagnostics"
        >
          <span />
        </button>
      </div>

      <div class="privacy-boundary">
        <strong>Basisbericht:</strong> Arten und Anzahl technischer Fehler, Runtime-Status und aggregierte Zähler.
        <strong>Ohne Chat-Diagnose:</strong> Keine Chat-Inhalte, Projektnamen, IDs, Server-Adressen, Tokens, Schlüssel,
        lokalen Pfade oder Fehlermeldungstexte.
      </div>
    </section>

    <section class="privacy-card" aria-labelledby="chat-diagnostics-title">
      <div class="privacy-card__head">
        <div>
          <h4 id="chat-diagnostics-title">Ausführliche Chat- und Tool-Diagnose</h4>
          <p>
            Speichert ab Aktivierung Modellanfragen, öffentliche Antworten, Tool-Argumente, Ergebnisse, Fehler und
            Laufzeiten. Diese Inhalte können Projekt- und Dateitexte enthalten und werden auf Debug-Anforderung an deine
            Server-Administration übertragen.
          </p>
          <p>
            Erkannte Zugangsdaten, private Denkkanäle und Binärdaten werden entfernt. Bis zu 500 Ereignisse / 4 MiB;
            gekürzte Inhalte und entfernte alte Ereignisse werden im Export ausgewiesen.
          </p>
        </div>
        <button
          type="button"
          class="privacy-switch"
          :class="{ 'is-on': detailed && enabled }"
          role="switch"
          :aria-checked="detailed && enabled"
          aria-label="Ausführliche Chat-Diagnose"
          :disabled="busy || !enabled || !loaded"
          @click="toggleDetailed"
        >
          <span />
        </button>
      </div>
    </section>
    <section class="privacy-card" aria-labelledby="local-diagnostics-title">
      <div>
        <h4 id="local-diagnostics-title">Lokale Diagnosedaten</h4>
        <p>Entfernt ausschließlich den lokalen Diagnosespeicher. Chats, Projekte und Einstellungen bleiben erhalten.</p>
      </div>
      <div class="privacy-actions">
        <button type="button" class="privacy-button" :disabled="busy" @click="clearDiagnostics">
          {{ busy ? 'Bitte warten …' : 'Diagnosedaten löschen' }}
        </button>
      </div>
    </section>

    <p
      v-if="status"
      class="privacy-status"
      :class="status.ok ? 'is-ok' : 'is-error'"
      :role="status.ok ? 'status' : 'alert'"
      aria-live="polite"
    >
      {{ status.text }}
    </p>
  </div>
</template>

<style scoped>
.privacy-stack {
  display: flex;
  flex-direction: column;
  gap: var(--s4);
}

.privacy-card {
  display: flex;
  flex-direction: column;
  gap: var(--s3);
  padding: var(--s4);
  background: var(--surface-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-lg);
}

.privacy-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--s4);
}

.privacy-card h4 {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--fs-sm);
  font-weight: 700;
}

.privacy-card p {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.55;
}

.privacy-switch {
  position: relative;
  width: 48px;
  height: 28px;
  flex: none;
  padding: 0;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-pill);
  background: var(--bg-sunken);
  cursor: pointer;
  transition:
    background var(--dur),
    border-color var(--dur),
    box-shadow var(--dur);
}

.privacy-switch span {
  position: absolute;
  top: 4px;
  left: 4px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--text-muted);
  transition:
    transform var(--dur) var(--ease),
    background var(--dur);
}

.privacy-switch.is-on {
  border-color: var(--border-strong);
  background: var(--cy-16);
  box-shadow: var(--glow-xs);
}

.privacy-switch.is-on span {
  transform: translateX(20px);
  background: var(--cy-soft);
}

.privacy-switch:focus-visible,
.privacy-button:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.privacy-switch:disabled,
.privacy-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.privacy-boundary {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 5px 8px;
  padding: var(--s3);
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.5;
  background: var(--bg-sunken);
  border: 1px solid var(--border-hair);
  border-radius: var(--r-md);
}

.privacy-boundary strong {
  color: var(--text-secondary);
}

.privacy-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s2);
}

.privacy-button {
  min-height: 38px;
  padding: 0 16px;
  color: var(--danger-soft);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  font-weight: 600;
  background: var(--danger-wash);
  border: 1px solid rgba(244, 63, 94, 0.38);
  border-radius: var(--r-sm);
  cursor: pointer;
  transition:
    border-color var(--dur),
    box-shadow var(--dur),
    color var(--dur);
}

.privacy-button:hover:not(:disabled) {
  border-color: rgba(244, 63, 94, 0.65);
  box-shadow: var(--glow-danger);
}

.privacy-status {
  margin: 0;
  padding: 10px 12px;
  font-size: var(--fs-sm);
  border: 1px solid;
  border-radius: var(--r-md);
}

.privacy-status.is-ok {
  color: var(--success-soft);
  background: var(--success-wash);
  border-color: rgba(52, 211, 153, 0.35);
}

.privacy-status.is-error {
  color: var(--danger-soft);
  background: var(--danger-wash);
  border-color: rgba(244, 63, 94, 0.4);
}

@media (max-width: 640px) {
  .privacy-card__head {
    align-items: center;
  }

  .privacy-boundary {
    grid-template-columns: 1fr;
  }
}
</style>
