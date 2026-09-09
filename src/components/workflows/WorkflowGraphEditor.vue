<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { VueFlow, Handle, Position, useVueFlow, type Connection, type NodeDragEvent } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import type { WorkflowDefinition, WorkflowTask } from '@/services/workflows/types'
import { connectWorkflowSteps, moveWorkflowNode, workflowGraph } from '@/services/workflows/graph'
const props = withDefaults(
  defineProps<{ modelValue: WorkflowDefinition; catalog?: WorkflowTask[]; disabled?: boolean }>(),
  { catalog: () => [] }
)
const emit = defineEmits<{ 'update:modelValue': [value: WorkflowDefinition]; select: [key: string] }>()
const id = useId()
const flow = useVueFlow({ id })
const graph = computed(() => workflowGraph(props.modelValue, props.catalog))
const notice = ref('')
function move(event: NodeDragEvent) {
  if (props.disabled) return
  try {
    let next = props.modelValue
    for (const node of event.nodes) next = moveWorkflowNode(next, node.id, node.position)
    emit('update:modelValue', next)
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Position konnte nicht übernommen werden.'
  }
}
function connect(connection: Connection) {
  if (props.disabled) return
  try {
    emit('update:modelValue', connectWorkflowSteps(props.modelValue, connection.source, connection.target))
    notice.value = 'Ablaufverbindung im Entwurf ergänzt.'
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Verbindung konnte nicht übernommen werden.'
  }
}
</script>
<template>
  <section class="workflow-graph" aria-label="Workflow als Knotenansicht">
    <div class="workflow-graph__toolbar">
      <span>Knoten verschieben: nur Layout · Verbinden: Ablauf ändern</span>
      <div>
        <button type="button" aria-label="Workflow vergrößern" @click="flow.zoomIn()">+</button
        ><button type="button" aria-label="Workflow verkleinern" @click="flow.zoomOut()">−</button
        ><button type="button" @click="flow.fitView()">Einpassen</button>
      </div>
    </div>
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
        @node-click="emit('select', $event.node.id)"
      >
        <template #node-workflow="{ data }">
          <Handle id="in" type="target" :position="Position.Left" :connectable="!disabled" />
          <div class="workflow-node">
            <span class="workflow-node__location">{{ data.location }}</span>
            <strong>{{ data.title }}</strong
            ><span>{{ data.task }}</span>
            <dl>
              <dt>Eingabe</dt>
              <dd>{{ data.input }}</dd>
              <dt>Ausgabe</dt>
              <dd>{{ data.output }}</dd>
              <dt>Bei Fehler</dt>
              <dd>{{ data.failure }}</dd>
            </dl>
          </div>
          <Handle id="out" type="source" :position="Position.Right" :connectable="!disabled" />
        </template>
      </VueFlow>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p class="workflow-graph__legend">
      Durchgehend: Ablauf · Gestrichelt: Datenübergabe. Datenfelder und Fehlerpfade werden im ausgewählten Schritt
      bearbeitet.
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
  width: 225px;
  padding: 12px;
  border: 1px solid var(--ai-border, #525665);
  background: var(--ai-surface, #252933);
  border-radius: 8px;
  font:
    12px/1.45 system-ui,
    sans-serif;
  text-align: left;
}
.workflow-node strong,
.workflow-node > span {
  display: block;
  overflow-wrap: anywhere;
}
.workflow-node strong {
  font-size: 14px;
  margin: 4px 0;
}
.workflow-node__location {
  color: var(--ai-text-muted, #b5b9c7);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.workflow-node dl {
  margin: 10px 0 0;
  display: grid;
  grid-template-columns: 54px 1fr;
  gap: 3px 8px;
}
.workflow-node dt {
  color: var(--ai-text-muted, #b5b9c7);
}
.workflow-node dd {
  margin: 0;
  overflow-wrap: anywhere;
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
