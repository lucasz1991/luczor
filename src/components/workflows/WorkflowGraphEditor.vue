<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { VueFlow, Handle, Position, useVueFlow, type Connection, type NodeDragEvent } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import type { WorkflowDefinition, WorkflowTask, WorkflowTrigger } from '@/services/workflows/types'
import {
  connectWorkflowData,
  connectWorkflowSteps,
  moveWorkflowNode,
  workflowGraph,
  WORKFLOW_NODE_METRICS,
} from '@/services/workflows/graph'
const props = withDefaults(
  defineProps<{
    modelValue: WorkflowDefinition
    catalog?: WorkflowTask[]
    triggers?: WorkflowTrigger[]
    disabled?: boolean
  }>(),
  { catalog: () => [], triggers: () => [] }
)
const emit = defineEmits<{
  'update:modelValue': [value: WorkflowDefinition]
  select: [key: string]
  'select-source': [kind: 'input' | 'event' | 'trigger']
}>()
const id = useId()
const flow = useVueFlow({ id })
const graph = computed(() => workflowGraph(props.modelValue, props.catalog, props.triggers))
const notice = ref('')
const sourceField = ref('')
const targetField = ref('')
const sourceOptions = computed(() =>
  graph.value.nodes.flatMap(node =>
    node.data.outputs.map(field => ({
      value: `${node.id}|${field.path}`,
      label: `${node.data.title} · ${field.path} (${field.type})`,
    }))
  )
)
const targetOptions = computed(() =>
  graph.value.nodes
    .filter(node => !node.data.sourceKind)
    .flatMap(node =>
      node.data.inputs.map(field => ({
        value: `${node.id}|${field.path}`,
        label: `${node.data.title} · ${field.path} (${field.type})`,
      }))
    )
)
function selectNode(key: string) {
  const node = graph.value.nodes.find(item => item.id === key)
  if (node?.data.sourceKind) emit('select-source', node.data.sourceKind)
  else emit('select', key)
}
function bindFields() {
  const [source, sourcePath] = sourceField.value.split('|')
  const [target, targetPath] = targetField.value.split('|')
  if (!source || !sourcePath || !target || !targetPath) return
  connect({ source, target, sourceHandle: `data:${sourcePath}`, targetHandle: `data:${targetPath}` })
}
function move(event: NodeDragEvent) {
  if (props.disabled) return
  try {
    let next = props.modelValue
    for (const node of event.nodes) if (!node.id.startsWith('@')) next = moveWorkflowNode(next, node.id, node.position)
    emit('update:modelValue', next)
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Position konnte nicht übernommen werden.'
  }
}
function connect(connection: Connection) {
  if (props.disabled) return
  try {
    const sourceData = connection.sourceHandle?.startsWith('data:')
    const targetData = connection.targetHandle?.startsWith('data:')
    if (sourceData !== targetData) throw new Error('Verbinde Datenfelder miteinander oder beide Ablaufanschlüsse.')
    if (sourceData) {
      emit(
        'update:modelValue',
        connectWorkflowData(
          props.modelValue,
          props.catalog,
          connection.source,
          connection.sourceHandle!.slice(5),
          connection.target,
          connection.targetHandle!.slice(5)
        )
      )
      notice.value =
        'Datenverbindung ergänzt. Bei Schrittergebnissen wird auch der Quellschritt abgewartet. Die Werte werden beim Ausführen erneut geprüft.'
    } else {
      emit('update:modelValue', connectWorkflowSteps(props.modelValue, connection.source, connection.target))
      notice.value = 'Ablaufverbindung im Entwurf ergänzt.'
    }
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Verbindung konnte nicht übernommen werden.'
  }
}
</script>
<template>
  <section class="workflow-graph" aria-label="Workflow als Knotenansicht">
    <div class="workflow-graph__toolbar">
      <span>Verschieben: nur Layout · Ablauf und Daten getrennt verbinden</span>
      <div>
        <button type="button" aria-label="Workflow vergrößern" @click="flow.zoomIn()">+</button
        ><button type="button" aria-label="Workflow verkleinern" @click="flow.zoomOut()">−</button
        ><button type="button" @click="flow.fitView()">Einpassen</button>
      </div>
    </div>
    <details class="workflow-graph__bindings">
      <summary>Datenfelder verbinden</summary>
      <div>
        <label
          >Quelle<select v-model="sourceField" :disabled="disabled">
            <option value="">Feld wählen</option>
            <option v-for="field in sourceOptions" :key="field.value" :value="field.value">{{ field.label }}</option>
          </select></label
        >
        <label
          >Ziel<select v-model="targetField" :disabled="disabled">
            <option value="">Feld wählen</option>
            <option v-for="field in targetOptions" :key="field.value" :value="field.value">{{ field.label }}</option>
          </select></label
        >
        <button type="button" :disabled="disabled || !sourceField || !targetField" @click="bindFields">
          Daten verbinden
        </button>
      </div>
    </details>
    <div class="workflow-graph__canvas">
      <VueFlow
        :id="id"
        :nodes="graph.nodes"
        :edges="graph.edges"
        :nodes-draggable="!disabled"
        :nodes-connectable="!disabled"
        :edges-updatable="false"
        :delete-key-code="null"
        :min-zoom="0.2"
        :max-zoom="2"
        fit-view-on-init
        @node-drag-stop="move"
        @connect="connect"
        @node-click="selectNode($event.node.id)"
      >
        <template #node-workflow="{ data }">
          <Handle
            v-if="!data.sourceKind"
            id="in"
            type="target"
            :position="Position.Left"
            :connectable="!disabled"
            :style="{ top: '18px' }"
          />
          <Handle
            v-else-if="data.sourceKind !== 'trigger'"
            id="trigger"
            type="target"
            :position="Position.Left"
            :connectable="false"
          />
          <div
            class="workflow-node"
            :class="{ 'workflow-node--source': data.sourceKind }"
            :style="{
              width: `${data.layout.width}px`,
              height: `${data.layout.height}px`,
              padding: `${WORKFLOW_NODE_METRICS.padding}px`,
              '--workflow-summary-height': `${WORKFLOW_NODE_METRICS.summary}px`,
              '--workflow-port-height': `${WORKFLOW_NODE_METRICS.port}px`,
            }"
          >
            <div class="workflow-node__summary">
              <span class="workflow-node__location" :title="data.location">{{ data.location }}</span>
              <strong :title="data.title">{{ data.title }}</strong
              ><span :title="data.task">{{ data.task }}</span>
              <dl>
                <dt>Eingabe</dt>
                <dd :title="data.input">{{ data.input }}</dd>
                <dt>Ausgabe</dt>
                <dd :title="data.output">{{ data.output }}</dd>
                <dt>Bei Fehler</dt>
                <dd :title="data.failure">{{ data.failure }}</dd>
              </dl>
            </div>
            <div v-if="data.inputs.length || data.outputs.length" class="workflow-node__ports">
              <div v-for="field in data.inputs" :key="`in:${field.path}`" class="workflow-node__port">
                <Handle :id="`data:${field.path}`" type="target" :position="Position.Left" :connectable="!disabled" />
                <span :title="field.path">→ {{ field.path }}</span
                ><small :title="field.type">{{ field.type }}</small>
              </div>
              <div
                v-for="field in data.outputs"
                :key="`out:${field.path}`"
                class="workflow-node__port workflow-node__port--out"
              >
                <span :title="field.path">{{ field.path }} →</span><small :title="field.type">{{ field.type }}</small>
                <Handle :id="`data:${field.path}`" type="source" :position="Position.Right" :connectable="!disabled" />
              </div>
            </div>
          </div>
          <Handle
            v-if="!data.sourceKind"
            id="out"
            type="source"
            :position="Position.Right"
            :connectable="!disabled"
            :style="{ top: '18px' }"
          />
          <Handle
            v-else-if="data.sourceKind === 'trigger'"
            id="trigger"
            type="source"
            :position="Position.Right"
            :connectable="false"
          />
        </template>
      </VueFlow>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p class="workflow-graph__legend">
      Durchgehend: Ablauf · Gestrichelt: Datenübergabe · Gepunktet: Auslöser. Typen werden vorab abgeglichen; unbekannte
      Typen benötigen die Laufzeitprüfung. Auslöser und Eingaben öffnen ihre vorhandene Verwaltung.
    </p>
  </section>
</template>
<style scoped>
.workflow-graph {
  border: 1px solid var(--ai-border, #3d404b);
  border-radius: 9px;
  overflow: hidden;
  margin: 12px 0;
  color: var(--ai-text, #e7e9f0);
  background: var(--ai-surface, #20232b);
}
.workflow-graph__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--ai-border, #3d404b);
}
.workflow-graph__toolbar div {
  display: flex;
  gap: 6px;
}
.workflow-graph__bindings {
  padding: 10px 12px;
  font-size: 12px;
}
.workflow-graph__bindings > div {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
  margin-top: 10px;
}
.workflow-graph__bindings label {
  display: grid;
  gap: 4px;
  min-width: 0;
  flex: 1 1 220px;
}
.workflow-graph__bindings select {
  width: 100%;
  min-width: 0;
  padding: 6px;
  background: var(--ai-bg, #181b21);
  color: inherit;
  border: 1px solid var(--ai-border, #3d404b);
  border-radius: 6px;
}
.workflow-node__ports {
  margin: 10px -12px 0;
  border-top: 1px solid var(--ai-border, #3d404b);
  padding-top: 4px;
}
.workflow-node__port {
  box-sizing: border-box;
  height: var(--workflow-port-height);
  position: relative;
  padding: 3px 12px;
  display: flex;
  gap: 8px;
  justify-content: space-between;
  line-height: 20px;
}
.workflow-node__port span {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workflow-node__port small {
  flex: 0 1 90px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ai-text-muted, #b5b9c7);
}
.workflow-node__port--out {
  text-align: right;
}
.workflow-node--source {
  border-style: dashed;
}
button {
  min-height: 32px;
  padding: 4px 10px;
  background: transparent;
  color: inherit;
  border: 1px solid var(--ai-border, #4a4e5c);
  border-radius: 6px;
  cursor: pointer;
}
button:focus-visible {
  outline: 2px solid var(--ai-accent, #ac95ea);
  outline-offset: 2px;
}
.workflow-graph__canvas {
  height: 440px;
  min-height: 280px;
  background: var(--ai-bg, #181b21);
}
.workflow-node {
  box-sizing: border-box;
  border: 1px solid var(--ai-border, #525665);
  background: var(--ai-surface, #252933);
  border-radius: 8px;
  font:
    12px/1.45 system-ui,
    sans-serif;
  text-align: left;
}
.workflow-node__summary {
  display: grid;
  grid-template-rows: 14px 36px 18px 90px;
  gap: 4px;
  height: var(--workflow-summary-height);
  min-width: 0;
}
.workflow-node__summary > span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}
.workflow-node strong,
.workflow-node dd {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.workflow-node strong {
  font-size: 14px;
  line-height: 18px;
  margin: 0;
}
.workflow-node__location {
  color: var(--ai-text-muted, #b5b9c7);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.workflow-node dl {
  margin: 0;
  display: grid;
  grid-template-columns: 54px 1fr;
  grid-template-rows: repeat(3, 28px);
  gap: 3px 8px;
}
.workflow-node dt {
  color: var(--ai-text-muted, #b5b9c7);
}
.workflow-node dd {
  margin: 0;
  min-width: 0;
  line-height: 14px;
}
.workflow-graph p {
  padding: 0 12px;
  font-size: 12px;
}
.workflow-graph__legend {
  color: var(--ai-text-muted, #b5b9c7);
}
:deep(.vue-flow__edge-text) {
  font-size: 10px;
}
:deep(.vue-flow__edge-textbg) {
  fill: #dfe1e8;
}
:deep(.vue-flow__node.selected .workflow-node) {
  border-color: var(--ai-accent, #ac95ea);
}
@media (max-width: 520px) {
  .workflow-graph__canvas {
    height: 320px;
  }
}
</style>
