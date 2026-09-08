<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { workflowChanged, type WorkflowChatReference } from '@/services/workflows/presentation'
import { isTerminalWorkflow, workflowStatusLabel } from '@/services/workflows/types'
const props = defineProps<{
  workflows: WorkflowChatReference[]
  projectId: string
  disabled?: boolean
  readOnly?: boolean
  hostOnly?: boolean
}>()
const emit = defineEmits<{
  open: [reference: WorkflowChatReference]
  discuss: [reference: WorkflowChatReference]
  action: [reference: WorkflowChatReference, action: 'test' | 'start' | 'stop']
}>()
const statuses = ref<Record<number, string>>({})
const verified = ref(false)
const error = ref('')
const acting = ref(false)
let abort = new AbortController()
let timer: ReturnType<typeof setInterval> | undefined
let refreshing = false
async function refresh() {
  if (
    props.hostOnly ||
    refreshing ||
    !props.workflows.some(
      item =>
        item.runId &&
        (!verified.value || !isTerminalWorkflow(Reflect.get(statuses.value, item.id) ?? item.status ?? ''))
    )
  )
    return
  refreshing = true
  const signal = abort.signal
  try {
    const { captureWorkflowAccess } = await import('@/services/workflows/access')
    const access = await captureWorkflowAccess({ projectId: props.projectId, signal }, undefined, false)
    const next: Record<number, string> = {}
    for (const workflow of props.workflows)
      if (workflow.runId) {
        const run = (await access.api.run(workflow.runId)).data
        await access.check()
        if (run.workflow_definition_id !== workflow.id || run.project_external_id !== props.projectId)
          throw new Error('Laufzuordnung wurde geändert.')
        next[workflow.id] = run.status
      }
    if (!signal.aborted) {
      statuses.value = next
      verified.value = true
    }
  } catch {
    if (!signal.aborted) verified.value = false
  } finally {
    refreshing = false
  }
}
async function act(workflow: WorkflowChatReference, action: 'test' | 'start' | 'stop') {
  if (props.disabled || props.readOnly || acting.value) return
  if (props.hostOnly) {
    emit('action', workflow, action)
    return
  }
  acting.value = true
  error.value = ''
  const signal = abort.signal
  try {
    const { workflowTools } = await import('@/services/tools/workflows')
    const tool = workflowTools.find(
      item => item.name === (action === 'stop' ? 'workflow_run_cancel' : 'workflow_run_start')
    )!
    const result = (await tool.execute(
      {
        workflow_id: workflow.id,
        ...(action === 'stop' ? { run_id: workflow.runId } : { sandbox: action === 'test' }),
      },
      { projectId: props.projectId, signal }
    )) as { ok: boolean; error?: string; workflow_ref?: WorkflowChatReference }
    if (signal.aborted) return
    if (!result.ok) throw new Error(result.error ?? 'Workflow-Aktion fehlgeschlagen.')
    if (result.workflow_ref) emit('open', result.workflow_ref)
    await refresh()
  } catch (failure) {
    if (!signal.aborted)
      error.value =
        String(failure instanceof Error ? failure.message : 'Aktion fehlgeschlagen.') +
        ' Öffne den Workflow für Eingaben und Details.'
  } finally {
    acting.value = false
  }
}
watch(
  () => [props.projectId, props.workflows.map(item => item.id + '/' + (item.runId ?? '')).join(',')] as const,
  () => {
    abort.abort()
    abort = new AbortController()
    verified.value = false
    statuses.value = {}
    error.value = ''
    if (timer) clearInterval(timer)
    void refresh()
    if (props.workflows.some(item => item.runId))
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') void refresh()
      }, 10000)
  },
  { immediate: true }
)
watch(workflowChanged, change => {
  if (change.projectId === props.projectId) void refresh()
})
onBeforeUnmount(() => {
  abort.abort()
  if (timer) clearInterval(timer)
})
</script>
<template>
  <section v-if="workflows.length" class="wf-chat-cards" aria-label="Workflows in diesem Gespräch">
    <article v-for="workflow in workflows" :key="workflow.id">
      <div>
        <small
          >WORKFLOW<span v-if="workflow.version"> · VERSION {{ workflow.version }}</span></small
        >
        <strong>{{ workflow.name }}</strong>
        <p v-if="workflow.summary">{{ workflow.summary }}</p>
        <span v-if="workflow.status"
          >{{ workflowStatusLabel(statuses[workflow.id] ?? workflow.status)
          }}{{ verified ? '' : ' · letzter bekannter Stand' }}</span
        >
      </div>
      <footer>
        <button type="button" @click="emit('open', workflow)">Öffnen</button>
        <button type="button" :disabled="disabled || readOnly || acting" @click="act(workflow, 'test')">Testen</button>
        <button type="button" :disabled="disabled || readOnly || acting" @click="act(workflow, 'start')">
          Starten
        </button>
        <button
          v-if="workflow.runId && !isTerminalWorkflow(statuses[workflow.id] ?? workflow.status ?? '')"
          type="button"
          :disabled="disabled || readOnly || acting || (statuses[workflow.id] ?? workflow.status) === 'cancelling'"
          @click="act(workflow, 'stop')"
        >
          Stoppen
        </button>
        <button type="button" :disabled="disabled" @click="emit('discuss', workflow)">Im Chat verbessern</button>
      </footer>
    </article>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.wf-chat-cards {
  display: grid;
  gap: 10px;
  margin: 16px 0;
}
.wf-chat-cards article {
  max-width: 560px;
  border: 1px solid var(--ai-line);
  border-radius: 10px;
  overflow: hidden;
  background: var(--ai-canvas);
}
.wf-chat-cards article > div {
  display: grid;
  gap: 6px;
  padding: 16px 18px;
}
.wf-chat-cards small {
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--ai-accent);
}
.wf-chat-cards strong {
  font-size: 14px;
  font-weight: 550;
}
.wf-chat-cards p {
  margin: 0;
  font-size: 12px;
  color: var(--ai-muted);
}
.wf-chat-cards span {
  font-size: 11px;
  color: var(--ai-muted);
}
.wf-chat-cards footer {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 18px;
  border-top: 1px solid var(--ai-line);
}
.wf-chat-cards button {
  background: none;
  border: 0;
  color: var(--ai-ink);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  padding: 3px 0;
}
.wf-chat-cards button:disabled {
  opacity: 0.45;
  cursor: default;
}
.wf-chat-cards button:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 4px;
}
</style>
