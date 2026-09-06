<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AiIcon from './AiIcon.vue'
import LoadingState from './LoadingState.vue'
import ThinkingState from './ThinkingState.vue'
import StreamingText from './StreamingText.vue'
import ApprovalCard from './ApprovalCard.vue'
import ToolChips from './ToolChips.vue'
import TaskRows from './TaskRows.vue'
import ChatComposer from './ChatComposer.vue'
import PromptBar from './PromptBar.vue'
import RecommendationCard from './RecommendationCard.vue'
import ContextCards from './ContextCards.vue'
import DiffTable from './DiffTable.vue'
import RecordsTable from './RecordsTable.vue'
import FilterTable from './FilterTable.vue'
import SidebarNav from './SidebarNav.vue'
import SearchList from './SearchList.vue'
import Flowchart from './Flowchart.vue'
import InsightCards from './InsightCards.vue'
import CodeBlock from './CodeBlock.vue'
import FineTuneCard from './FineTuneCard.vue'
import SelectionActions from './SelectionActions.vue'
import AgentScreen from './AgentScreen.vue'
import type { ActivityStep, ContextItem, SearchItem } from './types'

const props = defineProps<{ standalone?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const light = ref(false)
const page = ref<'chat' | 'components'>('chat')
const query = ref('')
const input = ref('')
const notice = ref('')
const active = ref(false)
const collapsed = ref(false)
const startedAt = ref(Date.now())
const answer = ref('')
const userText = ref('Wie sieht der nächste Schritt für Luczor aus?')
const variant = ref<'drive' | 'dots' | 'orbit'>('drive')
const tab = ref('projekt')
const approvalKey = ref(0)
const tuning = ref({ radius: 10, fontSize: 14, spacing: 18 })
const steps = ref<ActivityStep[]>([
  { id: 'context', label: 'Projektkontext gelesen', detail: 'README · Architektur · Projektplan', status: 'done' },
  { id: 'tools', label: 'Komponenten geprüft', detail: '21 Vue-Komponenten verfügbar', status: 'done' },
  { id: 'answer', label: 'Antwort vorbereitet', detail: 'Nächste Schritte zusammengeführt', status: 'done' },
])
const tools: ActivityStep[] = [
  { id: 'read', label: 'project_get_state', status: 'done', detail: 'Beispiel: Projektübersicht gelesen.' },
  { id: 'plan', label: 'plan_update', status: 'done', detail: 'Beispiel: Drei Schritte vorbereitet.' },
]
const context: ContextItem[] = [
  {
    id: 'readme',
    title: 'Projektübersicht',
    kind: 'MD',
    source: 'README.md · Beispielkontext',
    content:
      'Luczor verbindet einen persönlichen Workspace mit lokalem Projektkontext und einem kontrollierten Werkzeugzugriff.',
  },
  {
    id: 'plan',
    title: 'Nächste Schritte',
    kind: 'Plan',
    source: 'Projektplan · Beispieldaten',
    content: 'Zuerst den Kontext prüfen, danach die passende Aktion vorbereiten und das Ergebnis verifizieren.',
  },
]
const commands: SearchItem[] = [
  { id: 'plan', label: '/plan', description: 'Eine Aufgabe in Schritte aufteilen', icon: 'check' },
  { id: 'summary', label: '/zusammenfassen', description: 'Den Projektstand zusammenfassen', icon: 'spark' },
  { id: 'context', label: '@projekt', description: 'Den Projektkontext ansehen', icon: 'folder' },
]
const columns = [
  { key: 'name', label: 'Aufgabe' },
  { key: 'status', label: 'Status' },
  { key: 'scope', label: 'Bereich' },
]
const rows = [
  { id: 'a', name: 'Projektkontext prüfen', status: 'Erledigt', scope: 'Workspace' },
  { id: 'b', name: 'Chat verbessern', status: 'In Arbeit', scope: 'Oberfläche' },
  { id: 'c', name: 'Ergebnis verifizieren', status: 'Offen', scope: 'Qualität' },
]
const code =
  'const context = await project.read()\nconst plan = await agent.plan(context)\n\nreturn {\n  summary: plan.summary,\n  steps: plan.steps,\n}'
const finalAnswer =
  'Die neue Oberfläche gibt jeder Phase ihren Platz. **Du siehst, woran Luczor gerade arbeitet**, welche Tools verwendet werden und wann eine Entscheidung nötig ist.\n\nDer nächste Schritt ist eine konkrete Aufgabe im Projekt:\n\n1. Kontext und Ziel gemeinsam prüfen.\n2. Änderungen in nachvollziehbaren Schritten umsetzen.\n3. Das Ergebnis testen und zusammenfassen.\n\nDie Antwort bleibt lesbar – mit Listen, Tabellen und kopierbaren Codeblöcken.'
answer.value = finalAnswer
const entries = [
  ['loading', 'Loading State', 'Pixelraster mit Animation und gemessener Laufzeit'],
  ['thinking', 'Thinking', 'Aufklappbare Schritte mit echten Statuswerten'],
  ['streaming', 'Streaming Text', 'Antworten, Code, Aktionen und Folgefragen'],
  ['approval', 'Approval Card', 'Eine klare Entscheidung vor der Ausführung'],
  ['tools', 'Tool Chips', 'Kompakte Aufrufe mit aufklappbaren Details'],
  ['tasks', 'Task Rows', 'Arbeitsstände als Liste oder Kapseln'],
  ['chat', 'Chat', 'Chatfläche mit Tabs und Eingabe'],
  ['prompt', 'Prompt Bar', 'Eingabe, Aktionen, Kontext und Abbruch'],
  ['recommendation', 'Recommendation Card', 'Vorschläge übernehmen oder verwerfen'],
  ['context', 'Context Cards', 'Nachvollziehbare Quellen und Kontext'],
  ['diff', 'Diff Table', 'Änderungen einzeln zur Übernahme auswählen'],
  ['records', 'Records Table', 'Sortierbare Daten und zugängliche Tabellen'],
  ['filter', 'Filter Table', 'Daten nach ihrem Status filtern'],
  ['sidebar', 'Sidebar Nav', 'Projektwechsel, Suche und kompakte Navigation'],
  ['search', 'Search', 'Suche mit Pfeiltasten und Enter'],
  ['flow', 'Flowchart', 'Aufklappbare Schritte auf einem Punktraster'],
  ['insight', 'Insight Cards', 'Einblicke mit Verlauf und Seitennavigation'],
  ['code', 'Code Block', 'Zeilennummern, Diffs und Kopierfunktion'],
  ['tune', 'Fine-tune Card', 'Darstellung direkt anpassen'],
  ['selection', 'Selection Actions', 'Text markieren und als neuen Auftrag verwenden'],
  ['screen', 'Agent Screen', 'Einbindung einer vorhandenen Bildschirmansicht'],
].map(([id, title, description]) => ({ id: id!, title: title!, description: description! }))
const filtered = computed(() =>
  entries.filter(entry => `${entry.title} ${entry.description}`.toLowerCase().includes(query.value.toLowerCase()))
)
let timer: ReturnType<typeof setTimeout> | undefined
function stop() {
  clearTimeout(timer)
  active.value = false
  steps.value = steps.value.map(step => ({ ...step, status: step.status === 'running' ? 'canceled' : step.status }))
  notice.value = 'Beispielablauf gestoppt.'
}
function play() {
  stop()
  notice.value = ''
  userText.value = input.value.trim() || 'Wie sieht der nächste Schritt für Luczor aus?'
  input.value = ''
  active.value = true
  answer.value = ''
  startedAt.value = Date.now()
  steps.value = [
    { id: 'context', label: 'Projektkontext lesen', status: 'running', detail: 'Beispielablauf' },
    { id: 'tools', label: 'Komponenten prüfen', status: 'pending' },
    { id: 'answer', label: 'Antwort vorbereiten', status: 'pending' },
  ]
  timer = setTimeout(() => {
    steps.value[0]!.status = 'done'
    steps.value[1]!.status = 'running'
    timer = setTimeout(() => {
      steps.value[1]!.status = 'done'
      steps.value[2]!.status = 'running'
      let length = 0
      function stream() {
        length += 24
        answer.value = finalAnswer.slice(0, length)
        if (length < finalAnswer.length) timer = setTimeout(stream, 70)
        else {
          active.value = false
          steps.value[2]!.status = 'done'
          notice.value = 'Beispielablauf abgeschlossen.'
        }
      }
      stream()
    }, 1100)
  }, 1000)
}
function showNotice(text: string) {
  notice.value = text
}
function resetPreview() {
  stop()
  answer.value = ''
  input.value = ''
  notice.value = 'Neue Beispielunterhaltung.'
}
function selectCommand(id: string) {
  input.value =
    id === 'plan'
      ? 'Erstelle einen Arbeitsplan.'
      : id === 'context'
        ? 'Zeige mir den Projektkontext.'
        : 'Fasse den Projektstand zusammen.'
}
function onCancel(event: Event) {
  if (props.standalone) {
    event.preventDefault()
    page.value = 'chat'
  } else emit('close')
}
onMounted(async () => {
  await nextTick()
  dialog.value?.showModal()
})
onBeforeUnmount(() => clearTimeout(timer))
</script>
<template>
  <dialog
    ref="dialog"
    class="ai-library"
    :class="{ 'ai-light': light }"
    aria-labelledby="ai-library-title"
    @cancel="onCancel"
  >
    <header class="ai-library__header">
      <div>
        <span class="ai-brand-mark"><AiIcon :size="22" /></span>
        <h1 id="ai-library-title">Luczor <span>AI Workspace</span></h1>
        <span class="ai-library__preview">Interaktive Vorschau · Beispieldaten</span>
      </div>
      <div>
        <button class="ai-button" type="button" @click="light = !light">{{ light ? 'Dunkel' : 'Hell' }}</button
        ><button
          v-if="!standalone"
          class="ai-icon-button"
          type="button"
          aria-label="Komponentenbibliothek schließen"
          @click="emit('close')"
        >
          <AiIcon name="close" />
        </button>
      </div>
    </header>
    <div class="ai-library__tabs">
      <button type="button" :aria-pressed="page === 'chat'" @click="page = 'chat'">Chat-Vorschau</button
      ><button type="button" :aria-pressed="page === 'components'" @click="page = 'components'">
        Alle 21 Komponenten</button
      ><span>Beautiful UI → Vue 3</span>
    </div>
    <div v-if="page === 'chat'" class="ai-library__workspace" :class="{ 'is-collapsed': collapsed }">
      <SidebarNav
        v-model:collapsed="collapsed"
        title="Luczor"
        :items="[
          { id: 'luczor', label: 'Luczor Workspace' },
          { id: 'design', label: 'Design & Ideen' },
          { id: 'research', label: 'Recherche' },
        ]"
        active-id="luczor"
        @select="showNotice('Projektwechsel ist in dieser Vorschau ein Beispiel.')"
        @new-chat="resetPreview"
        @add-project="showNotice('Projektordner werden in der Tauri-App ausgewählt.')"
        @library="page = 'components'"
        @settings="page = 'components'"
        @system="showNotice('Der echte Systemstatus ist in der Tauri-App verfügbar.')"
      />
      <main>
        <div class="ai-library__chat-head">
          <div><span class="ai-eyebrow">PROJEKT</span><strong>Luczor Workspace</strong></div>
          <button class="ai-button" type="button" @click="play"><AiIcon name="spark" />Ablauf abspielen</button>
        </div>
        <ChatComposer>
          <div class="ai-library__user">
            <span>Du</span>
            <p>{{ userText }}</p>
          </div>
          <div class="ai-library__assistant">
            <div class="ai-library__assistant-head"><AiIcon /> <strong>Luczor</strong><span>Gerade eben</span></div>
            <ThinkingState
              :active="active"
              :label="active ? 'Projekt wird verarbeitet' : 'Arbeitsschritte abgeschlossen'"
              :steps="steps"
              :started-at="startedAt"
              :duration-ms="active ? undefined : 4200"
              ><ToolChips :tools="tools" /></ThinkingState
            ><SelectionActions @action="(instruction, selection) => (input = `${instruction}: ${selection}`)"
              ><StreamingText
                :content="answer"
                :streaming="active && !!answer"
                :follow-ups="['Erstelle einen Arbeitsplan', 'Zeige die Komponenten']"
                :disabled="active"
                @follow-up="text => (input = text)"
                @speak="
                  showNotice('Vorlesen nutzt in der Tauri-App die eingerichtete Sprachausgabe.')
                " /></SelectionActions
            ><ContextCards v-if="answer && !active" :items="context" title="Verwendeter Beispielkontext" />
          </div>
          <template #composer
            ><PromptBar
              v-model="input"
              :busy="active"
              :commands="commands"
              context-label="Luczor Workspace"
              model-label="Vorschau"
              @send="play"
              @stop="stop"
              @command="selectCommand"
              @record="showNotice('Mikrofon ist in der Vorschau nicht aktiv.')"
              @listen="showNotice('Sprachfunktionen stehen in der Tauri-App bereit.')"
              @model="showNotice('Die Vorschau verwendet kein Modell.')"
              @context="showNotice('Hier werden ausschließlich Beispieldaten verwendet.')"
          /></template>
        </ChatComposer>
      </main>
    </div>
    <div v-else class="ai-library__catalog">
      <div class="ai-library__intro">
        <div>
          <span class="ai-eyebrow">DIE KOMPONENTENBIBLIOTHEK</span>
          <h2>Alles für einen klaren Dialog.</h2>
          <p>21 wiederverwendbare Vue-Bausteine. Jede Vorschau ist lokal bedienbar.</p>
        </div>
        <label class="ai-search__field"
          ><AiIcon name="search" /><input
            v-model="query"
            type="search"
            placeholder="Komponenten suchen"
            aria-label="Komponenten suchen"
        /></label>
      </div>
      <div class="ai-library__grid">
        <section
          v-for="(entry, index) in filtered"
          :id="`library-${entry.id}`"
          :key="entry.id"
          class="ai-library__item"
        >
          <header>
            <span>{{ String(index + 1).padStart(2, '0') }}</span>
            <h2>{{ entry.title }}</h2>
            <p>{{ entry.description }}</p>
          </header>
          <div class="ai-library__demo">
            <template v-if="entry.id === 'loading'"
              ><LoadingState label="Wird vorbereitet" :variant="variant" />
              <div class="ai-segmented">
                <button
                  v-for="v in ['drive', 'dots', 'orbit'] as const"
                  :key="v"
                  type="button"
                  :aria-pressed="variant === v"
                  @click="variant = v"
                >
                  {{ v }}
                </button>
              </div></template
            >
            <ThinkingState
              v-else-if="entry.id === 'thinking'"
              label="Drei Schritte abgeschlossen"
              :steps="steps"
              :expanded="true"
              :duration-ms="4200"
            />
            <StreamingText
              v-else-if="entry.id === 'streaming'"
              content="**Ein klarer nächster Schritt:** Projektkontext prüfen, Änderungen umsetzen und das Ergebnis verifizieren."
              :follow-ups="['Arbeitsplan erstellen']"
              @follow-up="showNotice"
              @speak="showNotice('Vorlesen ist in der Tauri-App verfügbar.')"
            />
            <template v-else-if="entry.id === 'approval'"
              ><ApprovalCard
                :key="approvalKey"
                title="Projektplan aktualisieren?"
                description="Der Agent möchte die nächsten Schritte im aktiven Projekt hinterlegen."
                detail="plan_update · 3 Schritte"
                @approve="showNotice('Beispiel: einmalige Freigabe erteilt.')"
                @reject="showNotice('Beispiel: Ausführung abgelehnt.')"
              /><button class="ai-icon-button" type="button" @click="approvalKey++">
                Beispiel zurücksetzen
              </button></template
            >
            <ToolChips
              v-else-if="entry.id === 'tools'"
              :tools="[
                ...tools,
                { id: 'waiting', label: 'file_write', status: 'waiting', detail: 'Wartet auf einmalige Freigabe.' },
              ]"
            />
            <TaskRows v-else-if="entry.id === 'tasks'" :tasks="steps" variant="capsules" />
            <ChatComposer
              v-else-if="entry.id === 'chat'"
              v-model:active-tab="tab"
              :tabs="[
                { id: 'projekt', label: 'Projekt' },
                { id: 'ideen', label: 'Ideen' },
              ]"
              ><StreamingText
                :content="tab === 'projekt' ? 'Der Projektkontext ist bereit.' : 'Hier beginnt die nächste Idee.'"
                :actions="false"
            /></ChatComposer>
            <PromptBar
              v-else-if="entry.id === 'prompt'"
              v-model="input"
              :commands="commands"
              context-label="Beispielprojekt"
              @send="showNotice('Beispielnachricht: ' + input)"
              @command="selectCommand"
              @model="showNotice('Modellauswahl öffnet in der App die vorhandenen Einstellungen.')"
              @context="showNotice('Beispielprojekt')"
              @record="showNotice('Mikrofon ist in dieser Vorschau nicht aktiv.')"
              @listen="showNotice('Dauer-Zuhören ist in dieser Vorschau nicht aktiv.')"
            />
            <RecommendationCard
              v-else-if="entry.id === 'recommendation'"
              title="Als Projektregel speichern?"
              description="Änderungen vor der Übergabe mit den passenden Prüfungen absichern."
              evidence="Vorschlag aus der Beispielunterhaltung"
              @accept="showNotice('Beispielregel übernommen.')"
              @dismiss="showNotice('Beispielregel verworfen.')"
            />
            <ContextCards v-else-if="entry.id === 'context'" :items="context" />
            <DiffTable
              v-else-if="entry.id === 'diff'"
              :changes="[
                { id: 'name', label: 'Titel', before: 'Neues Projekt', after: 'Luczor Workspace' },
                { id: 'status', label: 'Status', before: 'Offen', after: 'In Arbeit' },
              ]"
              @apply="ids => showNotice(`${ids.length} Beispieländerungen ausgewählt.`)"
            />
            <RecordsTable
              v-else-if="entry.id === 'records'"
              :columns="columns"
              :rows="rows"
              caption="Projektaufgaben · Beispieldaten"
            />
            <FilterTable v-else-if="entry.id === 'filter'" :columns="columns" :rows="rows" />
            <SidebarNav
              v-else-if="entry.id === 'sidebar'"
              v-model:collapsed="collapsed"
              :items="[
                { id: 'luczor', label: 'Luczor Workspace' },
                { id: 'research', label: 'Recherche' },
              ]"
              active-id="luczor"
              @select="showNotice"
              @new-chat="showNotice('Neuer Beispielchat')"
              @add-project="showNotice('Projektordner wählen')"
              @library="showNotice('Die Bibliothek ist bereits geöffnet.')"
              @settings="showNotice('Einstellungen')"
              @system="showNotice('Systemstatus')"
            />
            <SearchList
              v-else-if="entry.id === 'search'"
              :items="commands"
              placeholder="Aktionen durchsuchen"
              @select="showNotice"
            />
            <Flowchart v-else-if="entry.id === 'flow'" :steps="steps" />
            <InsightCards
              v-else-if="entry.id === 'insight'"
              :insights="[
                {
                  id: 'progress',
                  title: 'Projektfortschritt',
                  value: '3 / 5',
                  description: 'Beispiel: drei Aufgaben wurden abgeschlossen.',
                  points: [0, 1, 1, 2, 3],
                },
                {
                  id: 'quality',
                  title: 'Prüfungen',
                  value: '12 / 12',
                  description: 'Beispielwerte für eine Ergebnisübersicht.',
                  points: [2, 4, 7, 9, 12],
                },
              ]"
            />
            <CodeBlock v-else-if="entry.id === 'code'" :code="code" language="typescript" filename="workspace.ts" />
            <template v-else-if="entry.id === 'tune'"
              ><FineTuneCard v-model="tuning" />
              <div
                class="ai-card"
                :style="{
                  borderRadius: tuning.radius + 'px',
                  fontSize: tuning.fontSize + 'px',
                  padding: tuning.spacing + 'px',
                }"
              >
                Deine Vorschau passt sich direkt an.
              </div></template
            >
            <SelectionActions
              v-else-if="entry.id === 'selection'"
              @action="(instruction, selection) => showNotice(`${instruction}: ${selection}`)"
              ><p class="ai-muted">
                Markiere einen Teil dieses Texts. Du kannst ihn erklären lassen, verbessern oder kürzen. Die Aktion wird
                in der App als neuer Auftrag vorbereitet.
              </p></SelectionActions
            >
            <AgentScreen v-else-if="entry.id === 'screen'" title="Agent-Ansicht" />
          </div>
        </section>
        <p v-if="!filtered.length" class="ai-empty">Keine Komponente gefunden.</p>
      </div>
      <footer class="ai-library__credit">
        Vue-Adaptionen nach Beautiful UI · © 2026 Shane Levine · MIT · Originalquellen und Lizenz liegen im Projekt
        unter vendor/beautiful-ui.
      </footer>
    </div>
    <div v-if="notice" class="ai-library__notice" role="status">
      <AiIcon name="check" /><span>{{ notice }}</span
      ><button class="ai-icon-button" type="button" aria-label="Hinweis schließen" @click="notice = ''">
        <AiIcon name="close" />
      </button>
    </div>
  </dialog>
</template>
<style scoped>
.ai-library {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100dvh;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  background: var(--ai-page);
  overflow: hidden;
  color: var(--ai-ink);
}
.ai-library[open] {
  display: flex;
  flex-direction: column;
}
.ai-library::backdrop {
  background: #0009;
}
.ai-library__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 67px;
  padding: 14px 28px;
  border-bottom: 1px solid var(--ai-line);
}
.ai-library__header > div {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ai-library h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.035em;
}
.ai-library h1 span {
  color: var(--ai-muted);
  font-weight: 400;
  margin-left: 7px;
}
.ai-library__preview {
  padding: 4px 8px;
  border: 1px solid var(--ai-line);
  border-radius: 5px;
  color: var(--ai-muted);
  font-size: 10px;
}
.ai-library__tabs {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 47px;
  padding: 7px 26px;
  border-bottom: 1px solid var(--ai-line);
}
.ai-library__tabs button {
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  color: var(--ai-muted);
  background: transparent;
  font-size: 12px;
}
.ai-library__tabs button[aria-pressed='true'] {
  color: var(--ai-ink);
  background: var(--ai-hover);
}
.ai-library__tabs > span {
  margin-left: auto;
  color: var(--ai-faint);
  font-size: 10px;
}
.ai-library__workspace {
  display: grid;
  grid-template-columns: 218px minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}
.ai-library__workspace.is-collapsed {
  grid-template-columns: 62px minmax(0, 1fr);
}
.ai-library__workspace main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.ai-library__chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 28px;
  border-bottom: 1px solid var(--ai-line);
}
.ai-library__chat-head .ai-eyebrow {
  font-size: 9px;
  letter-spacing: 0.12em;
  margin-bottom: 4px;
}
.ai-library__chat-head strong {
  font-size: 13px;
  font-weight: 550;
}
.ai-library__user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  margin: 0 0 28px;
}
.ai-library__user > span {
  color: var(--ai-faint);
  font-size: 10px;
}
.ai-library__user p {
  max-width: 85%;
  padding: 12px 16px;
  margin: 0;
  border: 1px solid var(--ai-line);
  border-radius: 12px 12px 4px 12px;
  background: var(--ai-surface);
  font-size: 13px;
  line-height: 1.65;
}
.ai-library__assistant-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 16px;
}
.ai-library__assistant-head strong {
  font-size: 12px;
  font-weight: 600;
}
.ai-library__assistant-head span {
  color: var(--ai-faint);
  font-size: 10px;
}
.ai-library__assistant :deep(.ai-context) {
  margin-top: 26px;
}
.ai-library__catalog {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 36px max(24px, calc((100vw - 1200px) / 2));
}
.ai-library__intro {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 32px;
}
.ai-library__intro h2 {
  font-size: 28px;
  font-weight: 500;
  letter-spacing: -0.04em;
  margin: 8px 0;
}
.ai-library__intro p {
  color: var(--ai-muted);
  font-size: 12px;
}
.ai-library__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 36px 24px;
}
.ai-library__item {
  min-width: 0;
}
.ai-library__item > header {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 4px 8px;
  padding-bottom: 13px;
}
.ai-library__item > header > span {
  font: 10px/22px var(--font-mono);
  color: var(--ai-faint);
}
.ai-library__item h2 {
  font-size: 13px;
  font-weight: 550;
  margin: 0;
}
.ai-library__item > header p {
  grid-column: 2;
  margin: 0;
  color: var(--ai-faint);
  font-size: 11px;
}
.ai-library__demo {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  min-height: 250px;
  border: 1px solid var(--ai-line);
  border-radius: 14px;
  background: var(--ai-canvas);
}
.ai-library__demo > .ai-sidebar {
  min-height: 360px;
  border: 1px solid var(--ai-line);
  border-radius: 10px;
}
.ai-library__demo > .ai-chat {
  min-height: 170px;
}
.ai-library__credit {
  color: var(--ai-faint);
  font-size: 11px;
  padding: 40px 0 14px;
  line-height: 1.7;
}
.ai-library__notice {
  position: absolute;
  z-index: 5;
  right: 20px;
  bottom: 20px;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(520px, calc(100% - 40px));
  padding: 10px 12px;
  border: 1px solid var(--ai-line-strong);
  border-radius: 9px;
  background: var(--ai-surface);
  box-shadow: 0 6px 24px #0006;
  font-size: 12px;
}
.ai-library__notice > svg {
  color: var(--ai-green);
  flex-shrink: 0;
}
.ai-library__notice span {
  overflow-wrap: anywhere;
}
@media (max-width: 800px) {
  .ai-library__grid {
    grid-template-columns: 1fr;
  }
  .ai-library__preview {
    display: none;
  }
  .ai-library__intro {
    align-items: stretch;
    flex-direction: column;
  }
  .ai-library__workspace {
    grid-template-columns: 62px minmax(0, 1fr);
  }
  .ai-library__workspace :deep(.ai-sidebar) {
    padding: 18px 9px;
  }
  .ai-library__workspace
    :deep(
      .ai-sidebar
        :is(
          strong,
          .ai-sidebar__brand > .ai-brand-mark,
          .ai-sidebar__section,
          button > span,
          footer small,
          .ai-search__field
        )
    ) {
    display: none;
  }
  .ai-library__workspace :deep(.ai-sidebar button) {
    justify-content: center;
    padding: 10px 4px;
  }
}
@media (max-width: 500px) {
  .ai-library__header {
    padding: 12px 14px;
  }
  .ai-library h1 span,
  .ai-library__tabs > span {
    display: none;
  }
  .ai-library__tabs {
    padding-inline: 12px;
  }
  .ai-library__chat-head {
    padding: 12px;
  }
  .ai-library__chat-head .ai-button {
    font-size: 10px;
  }
  .ai-library__demo {
    padding: 16px;
  }
  .ai-library__catalog {
    padding: 24px 16px;
  }
}
</style>
