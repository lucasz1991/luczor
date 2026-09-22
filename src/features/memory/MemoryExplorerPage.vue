<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AiIcon from '@/components/ai/AiIcon.vue'
import MemoryDreamPanel from './MemoryDreamPanel.vue'
import MemoryGraphBackdrop from './MemoryGraphBackdrop.vue'
import MemoryMetadataEditor from './MemoryMetadataEditor.vue'
import { MEMORY_SYSTEMS } from './graph'
import { loadMemoryGraphDisplay } from './graphDisplay'
import { useMemoryGraphData } from './useMemoryGraphData'

/**
 * This page owns the graph renderer and its visual data lifetime. Closing the page removes
 * both, while chat inference and memory maintenance remain owned by the app.
 */
const props = defineProps<{ projects: Array<{ id: string; name: string }>; projectId: string }>()
const emit = defineEmits<{ close: []; settings: [] }>()
const data = useMemoryGraphData()
const selectedMemory = computed(() =>
  data.inventory.value?.records.find(record => `memory:${record.id}` === data.selected.value)
)
const heading = ref<HTMLElement | null>(null)
const showDream = ref(true)
const showInspector = ref(true)
const showRemote = ref(false)
const projectModel = computed({
  get: () => data.project.value,
  set: value => data.setProject(value),
})
const systemModel = computed({
  get: () => data.system.value,
  set: value => data.setSystem(value),
})
const stats = computed(() => ({
  nodes: data.graph.value.nodes.length,
  edges: data.graph.value.edges.filter(edge => !edge.grouping).length,
}))
const onlyHubs = computed(() => !data.loading.value && data.graph.value.nodes.every(node => node.kind === 'System'))
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && showRemote.value) {
    event.preventDefault()
    showRemote.value = false
  }
}
watch(
  () => props.projectId,
  id => data.setProject(id)
)
onMounted(() => {
  data.ensureListening()
  data.ensureLoaded(props.projectId, 30_000)
  void loadMemoryGraphDisplay()
  void nextTick(() => heading.value?.focus())
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  data.stopListening()
})
</script>
<template>
  <MemoryGraphBackdrop />
  <main class="main-col memory-page" :class="{ 'has-dream': showDream, 'has-inspector': showInspector }">
    <!-- Floating toolbar -->
    <header class="memory-bar">
      <div class="memory-bar__title">
        <p class="memory-page__eyebrow">LUCZOR / WISSEN &amp; KONTEXT</p>
        <h1 ref="heading" tabindex="-1">3D-Wissensraum</h1>
      </div>
      <form class="memory-bar__filters" @submit.prevent="data.search()">
        <label>
          <span>Projekt</span>
          <select v-model="projectModel">
            <option value="">Kein Projekt</option>
            <option v-for="item in projects" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <label>
          <span>System</span>
          <select v-model="systemModel">
            <option value="">Alle Systeme</option>
            <option v-for="item in MEMORY_SYSTEMS" :key="item">{{ item }}</option>
          </select>
        </label>
        <label class="memory-bar__search">
          <span>Suche</span>
          <input v-model="data.query.value" maxlength="256" placeholder="Erinnerung oder Datei …" />
        </label>
        <button type="submit" class="ai-button" :disabled="data.loading.value">
          {{ data.loading.value ? 'Lädt …' : 'Aktualisieren' }}
        </button>
      </form>
      <div class="memory-bar__actions">
        <button
          type="button"
          class="ai-icon-button"
          :class="{ 'is-on': showDream }"
          title="Träumen-Seitenleiste"
          :aria-pressed="showDream"
          @click="showDream = !showDream"
        >
          <AiIcon name="spark" :size="15" />
        </button>
        <button
          type="button"
          class="ai-icon-button"
          :class="{ 'is-on': showInspector }"
          title="Inspektor-Seitenleiste"
          :aria-pressed="showInspector"
          @click="showInspector = !showInspector"
        >
          <AiIcon name="panel" :size="15" />
        </button>
        <button
          type="button"
          class="ai-icon-button"
          title="SQL / Cognee durchsuchen"
          :aria-pressed="showRemote"
          @click="showRemote = true"
        >
          <AiIcon name="search" :size="15" />
        </button>
        <button type="button" class="ai-icon-button" title="Projekteinstellungen" @click="emit('settings')">
          <AiIcon name="settings" :size="15" />
        </button>
        <button type="button" class="ai-button" @click="emit('close')">Zurück zum Chat</button>
      </div>
    </header>

    <p v-if="data.notice.value" role="status" class="memory-page__notice">{{ data.notice.value }}</p>

    <!-- Left: dreaming -->
    <Transition name="memory-slide-left">
      <aside v-if="showDream" class="memory-side memory-side--left" aria-label="Träumen · Leerlauf-Pflege">
        <MemoryDreamPanel
          :dream="data.dream.value"
          :trace="data.dreamTrace.value"
          :project-id="data.project.value"
          @focus="data.focusDreamTarget"
        />
      </aside>
    </Transition>

    <!-- Right: inspector -->
    <Transition name="memory-slide-right">
      <aside v-if="showInspector" class="memory-side memory-side--right" aria-label="Einträge und Details">
        <section class="memory-inspector">
          <h2>{{ data.detail.value?.kind ?? 'Inspektor' }}</h2>
          <h3>{{ data.detail.value?.label ?? 'Eintrag auswählen' }}</h3>
          <p class="memory-inspector__detail">
            {{ data.detail.value?.detail ?? 'Knoten in der Karte oder Liste auswählen.' }}
          </p>
          <MemoryMetadataEditor
            v-if="selectedMemory?.metadataRevision"
            :key="selectedMemory.id"
            :record="selectedMemory"
            @saved="data.load({ soft: true })"
          />
          <div class="memory-inspector__head">
            <h2>Einträge dieser Ansicht</h2>
            <span>{{ stats.nodes }} Knoten · {{ stats.edges }} Beziehungen</span>
          </div>
          <p v-if="onlyHubs" class="memory-inspector__hint">
            Keine passenden Dateneinträge geladen. Die Systemknoten sind die Legende, keine gespeicherten Erinnerungen.
          </p>
          <div class="memory-inspector__list">
            <button
              v-for="node in data.graph.value.nodes"
              :key="node.id"
              type="button"
              :aria-pressed="data.selected.value === node.id"
              @click="data.selected.value = node.id"
            >
              <span>{{ node.label }}</span
              ><small>{{ node.system }} · {{ node.kind }}</small>
            </button>
          </div>
          <div class="memory-inspector__pages">
            <div>
              <span
                >Erinnerungen {{ data.inventory.value?.records.length ? data.offset.value + 1 : 0 }}–{{
                  data.offset.value + (data.inventory.value?.records.length ?? 0)
                }}
                / {{ data.inventory.value?.filtered ?? '—' }}</span
              >
              <button
                type="button"
                :disabled="data.loading.value || !data.offset.value"
                aria-label="Vorherige Erinnerungen"
                @click="data.page('memory', -1)"
              >
                ←
              </button>
              <button
                type="button"
                :disabled="
                  data.loading.value || !data.inventory.value || data.offset.value + 80 >= data.inventory.value.filtered
                "
                aria-label="Weitere Erinnerungen"
                @click="data.page('memory', 1)"
              >
                →
              </button>
            </div>
            <div>
              <span
                >Repo-Dateien {{ data.repo.value?.files.length ? data.repoOffset.value + 1 : 0 }}–{{
                  data.repoOffset.value + (data.repo.value?.files.length ?? 0)
                }}
                / {{ data.repo.value?.total ?? '—' }}</span
              >
              <button
                type="button"
                :disabled="data.loading.value || !data.repoOffset.value"
                aria-label="Vorherige Repo-Dateien"
                @click="data.page('repo', -1)"
              >
                ←
              </button>
              <button
                type="button"
                :disabled="
                  data.loading.value || !data.repo.value || data.repoOffset.value + 40 >= data.repo.value.total
                "
                aria-label="Weitere Repo-Dateien"
                @click="data.page('repo', 1)"
              >
                →
              </button>
            </div>
          </div>
        </section>
      </aside>
    </Transition>

    <!-- Bottom hint -->
    <p class="memory-page__legend">
      Erinnerungen: alle Bereiche des aktuellen Kontos auf diesem Gerät · Repo und Server-Abruf: gewähltes Projekt ·
      Öffnen startet nichts.
    </p>

    <!-- Modal: shared search -->
    <Teleport to="body">
      <div v-if="showRemote" class="memory-modal" @click.self="showRemote = false">
        <section class="memory-modal__panel" role="dialog" aria-modal="true" aria-labelledby="memory-remote-title">
          <header>
            <div>
              <p class="memory-page__eyebrow">SQL / COGNEE</p>
              <h2 id="memory-remote-title">Gemeinsame Erinnerungen durchsuchen</h2>
            </div>
            <button type="button" class="ai-icon-button" aria-label="Schließen" @click="showRemote = false">
              <AiIcon name="close" :size="13" />
            </button>
          </header>
          <p>
            Sendet den Suchtext über die vorhandene Memory-Schnittstelle. Private lokale Inhalte werden nicht
            hochgeladen. Die Desktop-API stellt keinen vollständigen Cognee-Graphen bereit.
          </p>
          <form class="memory-modal__form" @submit.prevent="data.sharedSearch()">
            <input
              v-model="data.query.value"
              maxlength="256"
              placeholder="Suchtext …"
              aria-label="Suchtext für den Memory-Dienst"
            />
            <button
              type="submit"
              class="ai-button ai-button--primary"
              :disabled="
                !data.project.value || !data.query.value.trim() || data.loading.value || data.remoteLoading.value
              "
            >
              {{ data.remoteLoading.value ? 'Sucht …' : 'An Memory-Dienst senden' }}
            </button>
          </form>
          <p v-if="!data.project.value" class="memory-inspector__hint">Für den Abruf ein Projekt wählen.</p>
          <p v-if="data.remoteNotice.value" role="status">{{ data.remoteNotice.value }}</p>
          <ul v-if="data.remote.value.length" class="memory-modal__hits">
            <li v-for="hit in data.remote.value" :key="hit.id">
              <button
                type="button"
                @click="
                  () => {
                    data.selected.value = hit.id
                    showRemote = false
                  }
                "
              >
                {{ hit.label }}
              </button>
            </li>
          </ul>
        </section>
      </div>
    </Teleport>
  </main>
</template>
<style scoped>
/* The page is a transparent, click-through layer; only its panels take pointer events. */
main.memory-page {
  position: relative;
  display: block;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  background: transparent;
  color: var(--ai-ink);
  font: 13px/1.5 var(--ai-font);
  pointer-events: none;
}
.memory-bar,
.memory-side,
.memory-page__notice,
.memory-page__legend {
  pointer-events: auto;
}
h1,
h2,
h3,
p {
  margin: 0;
}
.memory-page__eyebrow {
  color: var(--ai-accent);
  font-size: 10px;
  letter-spacing: 0.12em;
  margin-bottom: 2px;
}
/* --- toolbar --- */
.memory-bar {
  position: absolute;
  top: 14px;
  left: 16px;
  right: 16px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border: 1px solid var(--ai-line);
  border-radius: 16px;
  background: color-mix(in srgb, var(--ai-surface) 72%, transparent);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  box-shadow: 0 18px 50px -30px rgba(0, 0, 0, 0.6);
}
.memory-bar__title h1 {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.02em;
  white-space: nowrap;
}
.memory-bar__filters {
  display: flex;
  align-items: end;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.memory-bar__filters label {
  display: grid;
  gap: 3px;
  min-width: 120px;
  font-size: 10.5px;
  color: var(--ai-muted);
}
.memory-bar__filters label > span {
  padding-left: 2px;
}
.memory-bar__search {
  flex: 1;
}
.memory-bar input,
.memory-bar select {
  box-sizing: border-box;
  width: 100%;
  min-height: 32px;
  border: 1px solid var(--ai-line);
  border-radius: 8px;
  padding: 5px 9px;
  background: color-mix(in srgb, var(--ai-page) 70%, transparent);
  color: var(--ai-ink);
  font: 12.5px var(--ai-font);
}
.memory-bar__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.memory-bar__actions .ai-icon-button.is-on {
  background: var(--ai-hover);
  border-color: var(--ai-accent);
}
/* --- side panels --- */
.memory-side {
  position: absolute;
  top: 92px;
  bottom: 52px;
  z-index: 2;
  width: min(360px, calc(50% - 40px));
  overflow: hidden auto;
  overscroll-behavior: contain;
  border: 1px solid var(--ai-line);
  border-radius: 16px;
  background: color-mix(in srgb, var(--ai-surface) 68%, transparent);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  box-shadow: 0 24px 60px -34px rgba(0, 0, 0, 0.65);
}
.memory-side--left {
  left: 16px;
}
.memory-side--right {
  right: 16px;
}
.memory-side--left :deep(.dream-panel) {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.memory-inspector {
  padding: 16px;
  display: grid;
  gap: 8px;
  align-content: start;
}
.memory-inspector h2 {
  font-size: 12px;
  font-weight: 600;
  color: var(--ai-muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.memory-inspector h3 {
  font-size: 15px;
  overflow-wrap: anywhere;
}
.memory-inspector__detail {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ai-muted);
  font-size: 12px;
  max-height: 32vh;
  overflow: auto;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--ai-line);
}
.memory-inspector__head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  margin-top: 6px;
}
.memory-inspector__head span {
  font: 10.5px var(--font-mono, monospace);
  color: var(--ai-faint);
}
.memory-inspector__hint {
  color: var(--ai-muted);
  font-size: 11.5px;
}
.memory-inspector__list {
  display: grid;
}
.memory-inspector__list button {
  display: grid;
  width: 100%;
  padding: 7px 8px;
  min-height: 40px;
  text-align: left;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ai-ink);
  cursor: pointer;
  font: inherit;
}
.memory-inspector__list button:hover {
  background: var(--ai-hover);
}
.memory-inspector__list button[aria-pressed='true'] {
  background: var(--ai-hover);
  box-shadow: inset 2px 0 var(--ai-accent);
}
.memory-inspector__list span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.memory-inspector__list small {
  color: var(--ai-muted);
  font-size: 10px;
}
.memory-inspector__pages {
  display: grid;
  gap: 6px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--ai-line);
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
}
.memory-inspector__pages > div {
  display: flex;
  align-items: center;
  gap: 4px;
}
.memory-inspector__pages span {
  flex: 1;
  color: var(--ai-muted);
}
.memory-inspector__pages button {
  width: 32px;
  min-height: 30px;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  color: var(--ai-ink);
  background: transparent;
  cursor: pointer;
  font: inherit;
}
.memory-inspector__pages button:disabled {
  opacity: 0.4;
  cursor: default;
}
/* --- notices --- */
.memory-page__notice {
  position: absolute;
  top: 92px;
  left: 50%;
  z-index: 3;
  transform: translateX(-50%);
  max-width: min(560px, calc(100% - 32px));
  padding: 8px 14px;
  border: 1px solid color-mix(in srgb, var(--ai-orange, #e6a23c) 45%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ai-surface) 80%, transparent);
  backdrop-filter: blur(14px);
  font-size: 12px;
}
.memory-page__legend {
  position: absolute;
  left: 50%;
  bottom: 14px;
  z-index: 2;
  transform: translateX(-50%);
  max-width: min(720px, calc(100% - 32px));
  padding: 6px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ai-surface) 55%, transparent);
  backdrop-filter: blur(12px);
  color: var(--ai-faint);
  font-size: 10.5px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* --- modal --- */
.memory-modal {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(4, 6, 12, 0.5);
  backdrop-filter: blur(6px);
}
.memory-modal__panel {
  width: min(560px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 20px 22px;
  border: 1px solid var(--ai-line-strong);
  border-radius: 18px;
  background: var(--ai-surface);
  color: var(--ai-ink);
  box-shadow: 0 30px 90px -30px rgba(0, 0, 0, 0.8);
  display: grid;
  gap: 12px;
}
.memory-modal__panel header {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 12px;
}
.memory-modal__panel h2 {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.memory-modal__panel > p {
  color: var(--ai-muted);
  font-size: 12px;
}
.memory-modal__form {
  display: flex;
  gap: 8px;
}
.memory-modal__form input {
  flex: 1;
  min-height: 34px;
  border: 1px solid var(--ai-line);
  border-radius: 8px;
  padding: 6px 10px;
  background: var(--ai-page);
  color: var(--ai-ink);
  font: 13px var(--ai-font);
}
.memory-modal__hits {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  max-height: 40vh;
  overflow: auto;
}
.memory-modal__hits button {
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border: 1px solid var(--ai-line);
  border-radius: 8px;
  background: transparent;
  color: var(--ai-ink);
  font: inherit;
  cursor: pointer;
}
.memory-modal__hits button:hover {
  background: var(--ai-hover);
}
/* --- transitions --- */
.memory-slide-left-enter-active,
.memory-slide-left-leave-active,
.memory-slide-right-enter-active,
.memory-slide-right-leave-active {
  transition:
    opacity 320ms var(--ease, ease),
    transform 420ms var(--ease, ease);
}
.memory-slide-left-enter-from,
.memory-slide-left-leave-to {
  opacity: 0;
  transform: translateX(-18px);
}
.memory-slide-right-enter-from,
.memory-slide-right-leave-to {
  opacity: 0;
  transform: translateX(18px);
}
@media (max-width: 1100px) {
  .memory-bar {
    flex-wrap: wrap;
  }
  .memory-side {
    top: 150px;
    width: min(320px, calc(50% - 24px));
  }
}
@media (max-width: 760px) {
  .memory-side {
    width: calc(100% - 32px);
    bottom: auto;
    max-height: 45vh;
  }
  .memory-side--right {
    top: auto;
    bottom: 52px;
  }
  .memory-page__legend {
    display: none;
  }
}
</style>
