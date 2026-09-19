<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  MEMORY_KINDS,
  parseMemoryClassification,
  type MemoryClassification,
  type MemoryMetadata,
} from '@/services/memory/memoryMetadata'
import { memoryExplorerData } from './explorerData'
import { classificationOriginLabels, evidenceLabels, memoryKindLabels } from './metadataPresentation'

const props = defineProps<{
  record: {
    id: string
    importance?: number
    tags?: string[]
    metadata?: MemoryMetadata
    metadataRevision: string
    syncError?: string
  }
}>()
const emit = defineEmits<{ saved: [] }>()
const baseline = ref('')
const expectedRevision = ref('')
const draft = ref({ kind: 'unknown', interest: '', importance: '50', categories: '', tags: '' })
const saving = ref(false)
const error = ref('')
const notice = ref('')
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const outdated = computed(() => expectedRevision.value !== props.record.metadataRevision)
function reload() {
  const metadata = props.record.metadata
  draft.value = {
    kind: metadata?.kind ?? 'unknown',
    interest: metadata?.interest == null ? '' : String(metadata.interest * 100),
    importance: String((props.record.importance ?? 0.5) * 100),
    categories: metadata?.categories.map(category => category.path.join(' > ')).join('\n') ?? '',
    tags: (props.record.tags ?? [])
      .filter(tag => !['maintenance-derived', 'idle-optimization', 'checkpoint'].includes(tag))
      .join(', '),
  }
  baseline.value = JSON.stringify(draft.value)
  expectedRevision.value = props.record.metadataRevision
  error.value = ''
  notice.value = ''
}
watch(() => props.record.id, reload, { immediate: true })
watch(
  () => props.record.metadataRevision,
  () => {
    if (!dirty.value && !saving.value) reload()
  }
)
async function save() {
  if (saving.value || !dirty.value || outdated.value) return
  const initial = JSON.parse(baseline.value) as typeof draft.value
  const patch: Record<string, unknown> = {}
  if (draft.value.kind !== initial.kind) patch.kind = draft.value.kind
  if (draft.value.interest !== initial.interest)
    patch.interest = String(draft.value.interest).trim() ? Number(draft.value.interest) / 100 : null
  if (draft.value.importance !== initial.importance) patch.importance = Number(draft.value.importance) / 100
  if (draft.value.categories !== initial.categories)
    patch.categories = draft.value.categories
      .split('\n')
      .filter(line => line.trim())
      .map(line => line.split('>').map(part => part.trim()))
  if (draft.value.tags !== initial.tags)
    patch.tags = draft.value.tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean)
  error.value = ''
  notice.value = ''
  saving.value = true
  try {
    const classification: MemoryClassification = parseMemoryClassification(patch)
    await memoryExplorerData.updateMetadata(props.record.id, classification, expectedRevision.value)
    baseline.value = JSON.stringify(draft.value)
    notice.value = 'Gespeichert. Deine Änderungen bleiben bei der automatischen Pflege erhalten.'
    emit('saved')
  } catch (cause) {
    error.value =
      cause instanceof Error && /stale|conflict|changed|scope/iu.test(cause.message)
        ? 'Die Erinnerung oder das Konto wurde zwischenzeitlich geändert. Bitte den aktuellen Stand laden.'
        : 'Änderungen konnten nicht gespeichert werden. Werte und Verbindung prüfen.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="memory-metadata" aria-label="Einordnung der Erinnerung">
    <dl v-if="record.metadata" class="memory-metadata__facts">
      <div>
        <dt>Beleglage</dt>
        <dd>{{ evidenceLabels[record.metadata.evidence.status] }}</dd>
      </div>
      <div>
        <dt>Bewertung</dt>
        <dd>
          {{ classificationOriginLabels[record.metadata.classification.origin] }} ·
          {{ new Date(record.metadata.classification.updatedAt).toLocaleString('de-DE') }}
        </dd>
      </div>
      <div>
        <dt>Belegprüfung</dt>
        <dd>
          {{
            record.metadata.evidence.verifiedAt === null
              ? 'Keine unabhängige Prüfung gespeichert'
              : new Date(record.metadata.evidence.verifiedAt).toLocaleString('de-DE')
          }}
        </dd>
      </div>
      <div v-if="record.metadata.overrides.length">
        <dt>Manuell festgelegt</dt>
        <dd>
          {{
            record.metadata.overrides
              .map(
                field =>
                  ({
                    kind: 'Art',
                    interest: 'Interesse',
                    categories: 'Kategorien',
                    tags: 'Tags',
                    importance: 'Wichtigkeit',
                  })[field]
              )
              .join(', ')
          }}
        </dd>
      </div>
    </dl>
    <p v-if="record.syncError" role="status">
      Metadaten noch nicht synchronisiert. Die lokale Fassung bleibt erhalten.
    </p>
    <details v-if="record.metadata?.files.length || record.metadata?.evidence.sources.length">
      <summary>Dateien und Herkunft</summary>
      <ul>
        <li v-for="file in record.metadata?.files" :key="`${file.repositoryId}:${file.path}:${file.relation}`">
          {{ file.relation === 'evidence' ? 'Beleg' : file.relation === 'related' ? 'Bezug' : 'Erwähnung' }}:
          <code>{{ file.path }}</code>
          <small v-if="file.revision">Revision: {{ file.revision }}</small>
        </li>
        <li v-for="source in record.metadata?.evidence.sources" :key="`${source.kind}:${source.id}`">
          {{ source.kind === 'chat' ? 'Chatnachricht' : 'Quelle'
          }}<span v-if="source.role">
            ({{ source.role === 'user' ? 'Nutzer' : source.role === 'assistant' ? 'Assistent' : 'Werkzeug' }})</span
          >: <code>{{ source.id }}</code>
        </li>
      </ul>
    </details>
    <details>
      <summary>Einordnung bearbeiten</summary>
      <form @submit.prevent="save">
        <label
          >Art<select v-model="draft.kind" :disabled="saving">
            <option v-for="kind in MEMORY_KINDS" :key="kind" :value="kind">{{ memoryKindLabels[kind] }}</option>
          </select></label
        >
        <label
          >Wichtigkeit (0–100)<input
            v-model="draft.importance"
            type="number"
            min="0"
            max="100"
            step="any"
            required
            :disabled="saving"
        /></label>
        <label
          >Persönliches Interesse (0–100)<input
            v-model="draft.interest"
            type="number"
            min="0"
            max="100"
            step="any"
            placeholder="Unbekannt"
            :disabled="saving"
        /></label>
        <label
          >Kategorien<textarea
            v-model="draft.categories"
            rows="3"
            placeholder="Software > Backend > Laravel"
            :disabled="saving"
          />
        </label>
        <p>Eine Hierarchie je Zeile, Ebenen mit &gt; trennen.</p>
        <label>Tags<input v-model="draft.tags" placeholder="Laravel, Performance" :disabled="saving" /></label>
        <p v-if="outdated" role="status">Es liegt eine neuere Fassung vor. Lade sie vor dem Speichern.</p>
        <p v-if="error" role="alert">{{ error }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>
        <div class="memory-metadata__actions">
          <button class="ai-button" type="submit" :disabled="saving || !dirty || outdated">
            {{ saving ? 'Speichert …' : 'Speichern' }}
          </button>
          <button v-if="dirty || outdated" class="ai-button" type="button" :disabled="saving" @click="reload">
            Aktuellen Stand laden
          </button>
        </div>
      </form>
    </details>
  </section>
</template>

<style scoped>
.memory-metadata {
  display: grid;
  gap: 0.75rem;
  font-size: 0.78rem;
  margin: 1rem 0;
}
.memory-metadata__facts {
  margin: 0;
  display: grid;
  gap: 0.5rem;
}
.memory-metadata__facts div {
  display: grid;
  gap: 0.15rem;
}
dt,
small {
  opacity: 0.7;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  padding: 0.35rem 0;
}
form {
  display: grid;
  gap: 0.65rem;
  padding-top: 0.65rem;
}
label {
  display: grid;
  gap: 0.25rem;
}
input,
select,
textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem;
  border: 1px solid var(--ai-border, #ffffff30);
  border-radius: 0.4rem;
  background: var(--ai-surface, #1b1c20);
  color: inherit;
  font: inherit;
}
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--ai-accent, #99b8ef);
  outline-offset: 2px;
}
p {
  margin: 0;
  line-height: 1.5;
}
ul {
  padding-left: 1rem;
  display: grid;
  gap: 0.4rem;
}
li,
code {
  overflow-wrap: anywhere;
}
small {
  display: block;
}
.memory-metadata__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
</style>
