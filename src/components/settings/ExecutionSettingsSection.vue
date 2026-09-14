<script setup lang="ts">
import { computed, ref } from 'vue'
import IdleOptimizationSettings from '@/components/IdleOptimizationSettings.vue'
import { searchToolCatalog, toolCategoryMap } from '@/services/tools/discovery'
import type { LuczorMode } from '@/services/inference/types'
import {
  capabilityAccess,
  capabilityAccessLabels,
  capabilityTitle,
  type ToolCapability,
} from '@/services/toolCapabilities'

const props = withDefaults(
  defineProps<{
    chatToolRounds?: number
    agentToolRounds?: number
    backgroundModelPreparation?: boolean
    backgroundContextPreparation?: boolean
    autoExecuteMutatingTools: boolean
    mode?: LuczorMode
    killSwitch?: boolean
    tools?: ToolCapability[]
  }>(),
  {
    chatToolRounds: 6,
    agentToolRounds: 12,
    backgroundModelPreparation: true,
    backgroundContextPreparation: true,
    mode: 'observe',
    killSwitch: false,
    tools: () => [],
  }
)
const emit = defineEmits<{
  (event: 'update:chatToolRounds', value: number): void
  (event: 'update:agentToolRounds', value: number): void
  (event: 'update:backgroundModelPreparation', value: boolean): void
  (event: 'update:backgroundContextPreparation', value: boolean): void
  (event: 'update:autoExecuteMutatingTools', value: boolean): void
}>()

const search = ref('')
const category = ref('')
const discoveryPool = computed(() =>
  props.tools.map(tool => ({
    type: 'function' as const,
    function: { name: tool.name, description: `${capabilityTitle(tool)} ${tool.description}`, parameters: {} },
  }))
)
const categoryOptions = computed(() => toolCategoryMap(discoveryPool.value))
const modeLabels: Record<LuczorMode, string> = { observe: 'Beobachten', act: 'Handeln', unrestricted: 'Vollzugriff' }
const capabilityGroups = computed(() => {
  const matches = new Map(
    searchToolCatalog(discoveryPool.value, search.value, category.value).map(item => [item.meta.name, item.meta])
  )
  const groups = new Map<string, Array<{ name: string; title: string; access: string; transient: boolean }>>()
  for (const tool of props.tools) {
    const title = capabilityTitle(tool)
    const metadata = matches.get(tool.name)
    if (!metadata) continue
    const group = metadata.path.join(' › ')
    const entries = groups.get(group) ?? []
    entries.push({
      name: tool.name,
      title,
      access:
        capabilityAccessLabels[capabilityAccess(tool, props.mode, props.autoExecuteMutatingTools, props.killSwitch)],
      transient: tool.dataHandling === 'ephemeral',
    })
    groups.set(group, entries)
  }
  return Array.from(groups, ([title, tools]) => ({ title, tools }))
})

function toggleAutoExecution(): void {
  emit('update:autoExecuteMutatingTools', !props.autoExecuteMutatingTools)
}
</script>

<template>
  <div class="lz-section">
    <div class="lz-section__head">
      <h3>Ausführung & Freigaben</h3>
      <p>Steuert, ob erlaubte datenverändernde Tools einzeln bestätigt werden müssen.</p>
    </div>
    <div class="lz-card">
      <div class="lz-card__head">
        <div>
          <div class="lz-card__title">Einfache Projektaktionen automatisch ausführen</div>
          <div class="lz-card__meta">
            Im Modus „Handeln“: Projektaktionen mit geringem Risiko. Desktop, Programme, Netzwerk und kritische
            Dateiaktionen benötigen weiterhin eine Freigabe.
          </div>
        </div>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': autoExecuteMutatingTools }"
          :aria-pressed="autoExecuteMutatingTools"
          aria-label="Einfache Projektaktionen automatisch ausführen"
          @click="toggleAutoExecution"
        >
          <span />
        </button>
      </div>
      <p class="lz-hint">
        Beobachten bleibt strikt schreibgeschützt. Der Not-Aus sperrt weiterhin alle Tools. Nicht erlaubte oder
        unbekannte Aktionen werden durch diese Einstellung nicht freigegeben.
      </p>
      <p class="lz-hint">
        Nach dem Speichern gilt eine Änderung vor dem nächsten Tool-Aufruf, auch in laufenden Aufträgen.
      </p>
    </div>
    <IdleOptimizationSettings />
    <div class="lz-card">
      <div class="lz-card__title">Im Hintergrund vorbereiten</div>
      <div class="lz-card__head">
        <div>
          <div class="lz-card__title">Lokales Modell bereithalten</div>
          <p class="lz-hint">
            Bereitet das konfigurierte Modell beim Öffnen vor und hält es für den nächsten Auftrag bereit. Nutzt
            Arbeitsspeicher und gegebenenfalls Grafikspeicher.
          </p>
        </div>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': backgroundModelPreparation }"
          :aria-pressed="backgroundModelPreparation"
          aria-label="Lokales Modell bereithalten"
          @click="emit('update:backgroundModelPreparation', !backgroundModelPreparation)"
        >
          <span />
        </button>
      </div>
      <div class="lz-card__head">
        <div>
          <div class="lz-card__title">Projektkontext vorab vorbereiten</div>
          <p class="lz-hint">
            Bereitet Projektziele, erlaubte Erinnerungen und das Assistentenprofil vor. Änderungen am Projekt, Konto
            oder den Einstellungen verwerfen den Zwischenspeicher.
          </p>
        </div>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': backgroundContextPreparation }"
          :aria-pressed="backgroundContextPreparation"
          aria-label="Projektkontext vorab vorbereiten"
          @click="emit('update:backgroundContextPreparation', !backgroundContextPreparation)"
        >
          <span />
        </button>
      </div>
    </div>
    <div class="lz-card">
      <div class="lz-card__title">Tool-Limits</div>
      <p class="lz-hint">
        Modellrunden pro Arbeitsabschnitt (1–64). Eine Runde kann mehrere Tool-Aufrufe enthalten. Änderungen gelten ab
        dem nächsten Abschnitt.
      </p>
      <label class="capability-search"
        >Normaler Chat: maximale Tool-Runden
        <input
          type="number"
          min="1"
          max="64"
          step="1"
          :value="chatToolRounds"
          @input="emit('update:chatToolRounds', Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label class="capability-search"
        >Arbeitsagent: maximale Tool-Runden
        <input
          type="number"
          min="1"
          max="64"
          step="1"
          :value="agentToolRounds"
          @input="emit('update:agentToolRounds', Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <p class="lz-hint">
        Beim Rundenlimit bleibt der Fortschritt in dieser Sitzung verfügbar: Weiterarbeiten oder mit einem Agententeam
        fortsetzen. Das Kontextfenster des Modells bleibt davon unabhängig.
      </p>
    </div>
    <div v-if="tools.length" class="lz-card capability-catalog">
      <div class="lz-card__title">Funktionsumfang</div>
      <p class="lz-hint">
        {{ tools.length }} registrierte Werkzeuge · Aktueller Modus: {{ modeLabels[mode] }}. Die Freigaben unten zeigen
        die Wirkung dieser Einstellungen nach dem Speichern. Projektordner, Desktopzugriff und Modellverbindung werden
        bei der Ausführung zusätzlich geprüft.
      </p>
      <p v-if="killSwitch" role="status" class="lz-hint">Not-Aus aktiv: Alle Werkzeuge sind gesperrt.</p>
      <label class="capability-search">
        <span>Funktion suchen</span>
        <input v-model="search" type="search" placeholder="Zum Beispiel Formular, screenshot oder Gedächtnis" />
      </label>
      <label class="capability-search">
        <span>Kategorie und Unterkategorie</span>
        <select v-model="category">
          <option value="">Alle Kategorien</option>
          <option v-for="node in categoryOptions" :key="node.id" :value="node.id">
            {{ '— '.repeat(node.id.split('/').length - 1) }}{{ node.label }} ({{ node.tools }})
          </option>
        </select>
      </label>
      <div aria-live="polite">
        <section v-for="group in capabilityGroups" :key="group.title" class="capability-group">
          <h4>
            {{ group.title }} <span>({{ group.tools.length }})</span>
          </h4>
          <ul>
            <li v-for="tool in group.tools" :key="tool.name">
              <div>
                <span class="capability-title">{{ tool.title }}</span>
                <small>{{ tool.name }}</small>
                <small v-if="tool.transient">Ergebnis wird nicht im Chatarchiv gespeichert</small>
              </div>
              <span class="capability-access">{{ tool.access }}</span>
            </li>
          </ul>
        </section>
        <p v-if="!capabilityGroups.length" role="status" class="lz-hint">Keine passende Funktion gefunden.</p>
      </div>
      <p class="lz-hint">
        Erinnerungen lassen sich gezielt abrufen und automatisch im Chatkontext ergänzen. Quelle, automatische Übernahme
        und Trefferzahl stellst du unter „Server“ ein. Bildschirmaufnahmen werden lokal angezeigt; ihr Bildinhalt wird
        dem Modell nicht automatisch übergeben.
      </p>
    </div>
  </div>
</template>

<style scoped>
.capability-search {
  display: grid;
  gap: 6px;
  margin: 16px 0;
  font-size: 13px;
}
.capability-search input,
.capability-search select {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-glass);
  color: var(--text-primary);
}
.capability-search input:focus-visible,
.capability-search select:focus-visible {
  outline: 2px solid var(--cy, #74c5d9);
  outline-offset: 2px;
}
.capability-group h4 {
  margin: 18px 0 4px;
  font-size: 13px;
}
.capability-group h4 span,
.capability-group small {
  color: var(--text-muted);
}
.capability-group ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.capability-group li {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-hair);
  font-size: 13px;
}
.capability-title {
  display: block;
}
.capability-group small {
  display: block;
  margin-top: 3px;
  font-size: 11px;
}
.capability-access {
  flex-shrink: 0;
  text-align: right;
  font-size: 11px;
  color: var(--text-secondary);
}
@media (max-width: 600px) {
  .capability-group li {
    flex-direction: column;
    gap: 4px;
  }
  .capability-access {
    text-align: left;
  }
}
</style>
