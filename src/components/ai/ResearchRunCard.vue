<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { ResearchRun, ResearchStage, ResearchStatus } from '@/services/research/types'
import { researchEvidenceFingerprint } from '@/services/research/evidence'

const props = defineProps<{ run: ResearchRun }>()
const emit = defineEmits<{
  pause: []
  resume: [clarification: string]
  stop: []
  'open-report': []
  'open-folder': []
}>()
const id = useId()
const clarification = ref('')
watch(
  () => props.run.id,
  () => {
    clarification.value = ''
  }
)
watch(
  () => props.run.clarifications,
  value => {
    if (clarification.value.trim() && value?.at(-1) === clarification.value.trim()) clarification.value = ''
  }
)
function updateClarification(event: Event): void {
  clarification.value = (event.target as HTMLTextAreaElement).value
}
const stages: Record<ResearchStage, string> = {
  planning: 'Fragen und Suchplan',
  collecting: 'Quellen lesen und sichern',
  synthesizing: 'Ergebnisse zusammenführen',
  reviewing: 'Aussagen und Aktualität prüfen',
  publishing: 'Bericht speichern und prüfen',
}
const statuses: Record<ResearchStatus, string> = {
  queued: 'Wartet auf Ausführung',
  running: 'Recherche läuft',
  paused: 'Pausiert',
  blocked: 'Zwischenstand · Klärung nötig',
  completed: 'Abgeschlossen',
  cancelled: 'Gestoppt',
}
const active = computed(() => ['queued', 'running'].includes(props.run.status))
const resumable = computed(() => ['paused', 'blocked'].includes(props.run.status))
const stoppable = computed(() => !['completed', 'cancelled'].includes(props.run.status))
const verifiedClaims = computed(() =>
  props.run.review?.inputFingerprint === researchEvidenceFingerprint(props.run)
    ? props.run.claims.filter(claim => claim.review?.supported).length
    : 0
)
</script>

<template>
  <section class="research-card" :aria-labelledby="`${id}-title`" :data-status="run.status">
    <div class="research-card__heading">
      <div class="research-card__intro">
        <span class="research-card__label">Deep Research</span>
        <h3 :id="`${id}-title`">{{ run.topic }}</h3>
      </div>
      <span class="research-card__status" role="status">{{ statuses[run.status] }}</span>
    </div>
    <p class="research-card__phase">{{ stages[run.stage] }}</p>
    <div class="research-card__counts">
      <span>{{ run.sources.length }} Quellen</span>
      <span>{{ verifiedClaims }}/{{ run.claims.length }} Aussagen geprüft</span>
      <span>{{ run.artifacts.length }} Dateien</span>
    </div>
    <ul v-if="run.blockers.length" class="research-card__blockers" aria-label="Offene Punkte">
      <li v-for="(blocker, index) in run.blockers" :key="index">{{ blocker }}</li>
    </ul>
    <details class="research-card__details">
      <summary>Quellen, Dateien und Stand</summary>
      <p>Berichtsstand: {{ run.asOf }}</p>
      <p v-if="run.outputDir" class="research-card__path">{{ run.outputDir }}</p>
      <ol v-if="run.questions.length" aria-label="Rechercheplan">
        <li v-for="question in run.questions" :key="question.id">
          {{ question.text }}{{ question.requiresFreshness ? ' · aktueller Stand erforderlich' : '' }}
        </li>
      </ol>
      <ul v-if="run.sources.length" aria-label="Gelesene Quellen">
        <li v-for="source in run.sources" :key="source.id">
          {{ source.title }}
          <span class="research-card__muted"
            >· {{ source.coverage === 'complete' ? 'gelesen' : 'Abschnitte gelesen' }}</span
          >
        </li>
      </ul>
      <ul v-if="run.artifacts.length" aria-label="Recherchedateien">
        <li v-for="artifact in run.artifacts" :key="artifact.id">
          {{ artifact.path }}{{ artifact.verifiedAt ? ' · geprüft' : ' · Prüfung offen' }}
        </li>
      </ul>
      <p v-if="!run.sources.length">Noch keine gelesenen Quellen.</p>
    </details>
    <div v-if="resumable" class="research-card__clarification">
      <label :for="`${id}-clarification`"
        >Ergänzung zur Recherche <span class="research-card__muted">(optional)</span></label
      >
      <textarea
        :id="`${id}-clarification`"
        :value="clarification"
        rows="2"
        maxlength="20000"
        placeholder="Fehlende Angaben ergänzen oder die Fragestellung präzisieren …"
        @input="updateClarification"
      />
    </div>
    <div class="research-card__actions">
      <button v-if="active" type="button" @click="emit('pause')">Pausieren</button>
      <button v-if="resumable" type="button" @click="emit('resume', clarification.trim())">Fortsetzen</button>
      <button v-if="stoppable" type="button" @click="emit('stop')">Stoppen</button>
      <button v-if="run.report?.htmlPath" type="button" @click="emit('open-report')">
        {{ run.status === 'completed' ? 'Bericht öffnen' : 'Zwischenbericht öffnen' }}
      </button>
      <button v-if="run.outputDir" type="button" @click="emit('open-folder')">Ordner öffnen</button>
    </div>
  </section>
</template>

<style scoped>
.research-card {
  box-sizing: border-box;
  min-width: 0;
  width: 100%;
  padding: 16px;
  margin: 12px 0;
  border: 1px solid var(--ai-line);
  border-radius: 12px;
  background: var(--ai-surface);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.research-card__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
}
.research-card__intro {
  min-width: 0;
  flex: 1 1 180px;
}
.research-card__label,
.research-card__muted {
  color: var(--text-muted);
  font-size: 12px;
}
.research-card h3 {
  margin: 3px 0 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.45;
}
.research-card__status {
  color: var(--text-secondary);
  font-size: 12px;
}
.research-card__phase {
  margin: 12px 0 6px;
}
.research-card__counts,
.research-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}
.research-card__counts {
  color: var(--text-muted);
  font-size: 12px;
}
.research-card__details {
  margin-top: 12px;
}
.research-card__details summary {
  cursor: pointer;
  color: var(--text-muted);
}
.research-card__details p {
  margin: 8px 0;
}
.research-card__path {
  font-size: 12px;
}
.research-card ul {
  padding-inline-start: 20px;
  margin: 10px 0;
}
.research-card li + li {
  margin-top: 5px;
}
.research-card__blockers {
  color: var(--text-primary);
}
.research-card__actions {
  margin-top: 14px;
  gap: 8px;
}
.research-card button {
  min-height: 32px;
  padding: 5px 10px;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.research-card button:hover {
  background: var(--ai-page);
}
.research-card button:focus-visible,
.research-card summary:focus-visible,
.research-card textarea:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 3px;
}
.research-card__clarification {
  margin-top: 12px;
}
.research-card__clarification label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
}
.research-card textarea {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  resize: vertical;
  padding: 8px 10px;
  font: inherit;
  color: inherit;
  background: var(--ai-page);
  border: 1px solid var(--ai-line-strong);
  border-radius: 6px;
}
</style>
