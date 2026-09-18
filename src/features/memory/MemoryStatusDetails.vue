<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMemoryStatus, openMemoryExplorerFromStatus } from './observatory'
import { repositoryLspDetail } from '@/services/repositoryLspStatus'
const props = defineProps<{ active: boolean; secondary?: boolean }>()
const emit = defineEmits<{ open: [] }>()
const openError = ref('')
const { snapshot, now, refresh } = useMemoryStatus(() => props.active, props.secondary)
const stale = computed(() => !snapshot.value || now.value - snapshot.value.at > 7000)
const names: Record<string, string> = {
  localRecall: 'Lokales Erinnern',
  sharedRecall: 'SQL / Cognee-Abruf',
  save: 'Erinnerung speichern',
  graphSearch: 'Graph durchsuchen',
  graphRead: 'Graph-Evidenz lesen',
  graphIndex: 'Repo indexieren',
}
const states: Record<string, string> = {
  ready: 'Index bereit',
  stale: 'Index veraltet',
  unbound: 'Kein Repo verbunden',
  unindexed: 'Noch nicht indexiert',
  indexing: 'Indexiert gerade',
  error: 'Indexfehler',
  waiting: 'Wartet auf Leerlauf',
  paused: 'Pausiert',
  running: 'Arbeitet',
  committing: 'Speichert',
  yielding: 'Gibt Chat Vorrang',
  cooldown: 'Warteintervall',
  stopped: 'Gestoppt',
  idle: 'Wartet',
  preparing: 'Modellstart',
  generating: 'KI verarbeitet',
  verifying: 'KI prüft',
  not_evaluated: 'Modelltest fehlt',
  passed: 'Modelltest bestanden',
  evaluation_running: 'Modelltest läuft',
  quality_regression: 'Qualitätsprüfung nicht bestanden',
  review_failure: 'Umschreiben nach Prüfverletzung pausiert',
}
const time = (at: number | null | undefined) => (at ? new Date(at).toLocaleTimeString('de-DE') : 'Noch nicht')
async function open() {
  openError.value = ''
  try {
    if (props.secondary) await openMemoryExplorerFromStatus()
    else emit('open')
  } catch {
    openError.value = 'Hauptfenster nicht erreichbar. Gedächtnis dort über die Seitenleiste öffnen.'
  }
}
</script>
<template>
  <section class="memory-status" aria-label="Gedächtnis und Graph im Detail">
    <p v-if="openError" role="status">{{ openError }}</p>
    <header>
      <div>
        <h3>Gedächtnis &amp; Graph</h3>
        <p>
          {{ snapshot?.projectName ?? 'Hauptfenster' }} ·
          {{ stale ? 'Keine aktuellen Messwerte' : 'Messwerte des Hauptfensters' }}
        </p>
      </div>
      <button type="button" @click="open">3D-Gedächtnis öffnen ↗</button>
    </header>
    <p v-if="stale" role="status">
      {{
        snapshot
          ? 'Die letzten Messwerte sind veraltet.'
          : 'Warte auf das Hauptfenster. Fehlende Werte sind nicht null Zugriffe.'
      }}
      <button type="button" @click="refresh">Erneut abrufen</button>
    </p>
    <template v-if="snapshot">
      <dl class="memory-totals">
        <div>
          <dt>Lokal gespeichert</dt>
          <dd>{{ snapshot.inventory?.total ?? '—' }}</dd>
        </div>
        <div>
          <dt>Aktiv / Kandidaten</dt>
          <dd>{{ snapshot.inventory ? `${snapshot.inventory.active} / ${snapshot.inventory.candidates}` : '—' }}</dd>
        </div>
        <div>
          <dt>Sync ausstehend</dt>
          <dd>{{ snapshot.inventory?.pending ?? '—' }}</dd>
        </div>
      </dl>
      <p>
        Chat-Kontext:
        {{
          snapshot.preferences
            ? snapshot.preferences.inject
              ? `an · bis ${snapshot.preferences.injectCount} Treffer`
              : 'aus'
            : 'unbekannt'
        }}
        · Automatisch merken:
        {{ snapshot.preferences ? (snapshot.preferences.autoRemember ? 'an' : 'aus') : 'unbekannt' }}
      </p>
      <div class="memory-table-wrap">
        <p v-for="row in snapshot.usageEvents" :key="row.origin">
          {{ row.origin === 'chat' ? 'Chat' : row.origin === 'idle' ? 'Idle-Pflege' : 'Inspektion' }}:
          {{ row.retrieved }} abgerufen · {{ row.included }} an Modellaufruf übergeben · {{ row.evaluated }} geprüft
        </p>
        <table>
          <caption>
            Seit Start des Hauptfensters / Kontowechsel. Übergeben zählt Quellen im eingereichten Kontext, nicht
            bestätigte Verarbeitung oder Nutzung in der Antwort. Chat, Pflege und Inspektion sind getrennt.
          </caption>
          <thead>
            <tr>
              <th>Operation</th>
              <th>Fertig</th>
              <th>Aktiv</th>
              <th>Fehler</th>
              <th>Treffer</th>
              <th>Zuletzt</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in snapshot.usage" :key="row.kind">
              <th>{{ names[row.kind] }}</th>
              <td>{{ row.completed }}</td>
              <td>{{ row.active }}</td>
              <td>{{ row.failed }}</td>
              <td>{{ ['save', 'graphIndex'].includes(row.kind) ? '—' : row.results }}</td>
              <td>
                {{ time(row.lastAt) }}<small v-if="row.lastMs !== null">{{ row.lastMs }} ms</small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <section class="memory-index">
        <p v-for="run in snapshot.providerRuns" :key="run.id">
          Cognee #{{ run.id }}: {{ run.status }} · {{ run.phase }}
          <template v-if="run.draining"> · Serverlauf läuft unabhängig weiter; nicht pausiert</template>
          <template v-if="run.failed"> · Fehler gemeldet</template>
          <template v-if="run.run_id"> · Lauf {{ run.run_id }}</template>
        </p>
        <p v-if="snapshot.care" role="status">
          Pflege: {{ states[snapshot.care.stage] ?? snapshot.care.stage }} · {{ snapshot.care.queued }} wartend ·
          {{ snapshot.care.checked }} Quellen geprüft · {{ snapshot.care.changed }} geändert ·
          {{ snapshot.care.conflicts }} Konflikte · {{ snapshot.care.blocked }} blockiert ·
          {{ snapshot.care.waitingForGate ?? 0 }} warten auf Freigabe. Modell auf diesem Gerät:
          {{ snapshot.care.modelId || 'noch keines' }} · Qualitätsfreigabe:
          {{ states[snapshot.care.quality] ?? snapshot.care.quality }}
        </p>
        <h4>Repository-Graph · {{ states[snapshot.graph?.status ?? ''] ?? 'Nicht verfügbar' }}</h4>
        <div class="memory-index__flow" aria-label="Index-Bestand, keine gemessene Auslastung">
          <span
            ><strong>{{ snapshot.graph?.files ?? '—' }}</strong
            >Dateien</span
          ><i aria-hidden="true">→</i
          ><span
            ><strong>{{ snapshot.graph?.symbols ?? '—' }}</strong
            >Symbole</span
          ><i aria-hidden="true">↔</i
          ><span
            ><strong>{{ snapshot.graph?.edges ?? '—' }}</strong
            >Beziehungen</span
          >
        </div>
        <p>
          Index:
          {{
            snapshot.graph?.last_indexed_at
              ? new Date(snapshot.graph.last_indexed_at * 1000).toLocaleString('de-DE')
              : 'Noch nicht'
          }}
          · Übersprungen: {{ snapshot.graph?.skipped ?? '—' }}
        </p>
        <p>
          LSP: {{ snapshot.graph?.lsp?.status ?? 'Nicht gemeldet'
          }}<template v-if="snapshot.graph?.lsp">
            · {{ snapshot.graph.lsp.scanned }} / {{ snapshot.graph.lsp.files }} Dateien ·
            {{ snapshot.graph.lsp.edges }} Verweise</template
          >
        </p>
        <p v-if="repositoryLspDetail(snapshot.graph?.lsp)">{{ repositoryLspDetail(snapshot.graph?.lsp) }}</p>
      </section>
      <p>
        Persönlichkeit: {{ snapshot.profile.source === 'admin' ? 'Admin-Profil' : 'Lokaler Entwurf' }} ·
        {{ snapshot.profile.skills }} Skills. Profil ist getrennt von gelernten Erinnerungen.
      </p>
      <p>
        Idle: {{ states[snapshot.idle?.phase ?? ''] ?? 'Nicht verfügbar' }} ·
        {{ snapshot.idle?.completed ?? '—' }} abgeschlossene Runden<span v-if="snapshot.idle?.task">
          · {{ snapshot.idle.task }}</span
        ><span v-if="snapshot.idle?.nextCheckAt"> · nächste Prüfung {{ time(snapshot.idle.nextCheckAt) }}</span>
      </p>
      <p class="memory-status__note">
        Cognee-Wartung:
        {{
          snapshot.maintenance === 'scheduled'
            ? 'Auf dem Server eingeplant, Abschluss nicht bestätigt'
            : snapshot.maintenance === 'unavailable'
              ? 'Nicht verfügbar'
              : 'Kein bestätigter Lauf'
        }}. API-Erreichbarkeit bestätigt weder Cognee-Gesundheit noch Indexierung. SQL/Cognee-Abrufe können lokale oder
        SQL-Fallback-Treffer liefern.
      </p>
    </template>
  </section>
</template>
<style scoped>
.memory-status {
  padding: 16px;
  color: var(--ai-ink);
  font: 12px/1.5 var(--ai-font);
}
header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
h3,
h4,
p {
  margin: 0 0 8px;
}
h3 {
  font-size: 16px;
}
h4 {
  font-size: 13px;
}
p,
dt,
caption {
  color: var(--ai-muted);
}
button {
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  background: var(--ai-surface);
  color: var(--ai-ink);
  cursor: pointer;
}
button:hover {
  border-color: var(--ai-accent);
}
.memory-totals {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  margin: 16px 0;
}
dd {
  margin: 0;
  font-size: 23px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.memory-table-wrap {
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
caption {
  text-align: left;
  font-size: 11px;
  padding-bottom: 8px;
}
th,
td {
  text-align: left;
  padding: 8px;
  border-bottom: 1px solid var(--ai-line);
}
tbody th {
  font-weight: 500;
}
small {
  display: block;
  color: var(--ai-muted);
}
.memory-index {
  padding: 16px 0;
}
.memory-index__flow {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 12px 0;
}
.memory-index__flow span {
  display: grid;
  color: var(--ai-muted);
}
strong {
  font-size: 22px;
  color: var(--ai-ink);
  font-variant-numeric: tabular-nums;
}
i {
  color: var(--ai-accent);
}
.memory-status__note {
  font-size: 11px;
}
</style>
