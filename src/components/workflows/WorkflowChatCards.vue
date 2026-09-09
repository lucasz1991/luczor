<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { workflowChanged, type WorkflowChatReference } from '@/services/workflows/presentation'
import { isTerminalWorkflow, workflowStatusLabel, type WorkflowRun } from '@/services/workflows/types'
import { readWorkflowRunBudget } from '@/services/workflows/runBudget'
import WorkflowRunBudget from './WorkflowRunBudget.vue'
const props = defineProps<{
  workflows: WorkflowChatReference[]
  projectId: string
  disabled?: boolean
  readOnly?: boolean
  hostOnly?: boolean
  hostRuns?: WorkflowRun[]
  hostRunsVerified?: boolean
}>()
const emit = defineEmits<{
  open: [reference: WorkflowChatReference]
  discuss: [reference: WorkflowChatReference]
  action: [reference: WorkflowChatReference, action: 'test' | 'start' | 'stop' | 'stop_after_step']
}>()
const statuses = ref<Record<number, string>>({})
const runs = ref<WorkflowRun[]>([])
const displayedRuns = computed(() => (props.hostOnly ? (props.hostRuns ?? []) : runs.value))
const currentVerified = computed(() => (props.hostOnly ? props.hostRunsVerified === true : verified.value))
function runFor(workflow: WorkflowChatReference) {
  return displayedRuns.value.find(
    run =>
      run.workflow_definition_id === workflow.id &&
      run.public_id === workflow.runId &&
      run.project_external_id === props.projectId
  )
}
function statusFor(workflow: WorkflowChatReference) {
  return runFor(workflow)?.status ?? statuses.value[workflow.id] ?? workflow.status ?? ''
}
function boundaryPending(workflow: WorkflowChatReference) {
  return readWorkflowRunBudget(runFor(workflow) ?? null, displayedRuns.value).boundaryStop === 'pending'
}
const verified = ref(false)
const error = ref('')
const acting = ref(false)
let abort = new AbortController()
let timer: ReturnType<typeof setInterval> | undefined
let refreshing = false
let refreshAgain = false
let readEpoch = 0
async function refresh(force = false) {
  if (refreshing) {
    if (force) refreshAgain = true
    return
  }
  if (
    props.hostOnly ||
    refreshing ||
    (!force &&
      !props.workflows.some(
        item =>
          item.runId &&
          (!verified.value || !isTerminalWorkflow(Reflect.get(statuses.value, item.id) ?? item.status ?? ''))
      ))
  )
    return
  refreshing = true
  const signal = abort.signal
  const epoch = ++readEpoch
  try {
    const { captureWorkflowAccess } = await import('@/services/workflows/access')
    const access = await captureWorkflowAccess({ projectId: props.projectId, signal }, undefined, false)
    const next: Record<number, string> = {}
    const nextRuns: WorkflowRun[] = []
    for (const workflow of props.workflows)
      if (workflow.runId) {
        const run = (await access.api.run(workflow.runId)).data
        await access.check()
        if (
          run.workflow_definition_id !== workflow.id ||
          run.public_id !== workflow.runId ||
          run.project_external_id !== props.projectId
        )
          throw new Error('Laufzuordnung wurde geändert.')
        next[workflow.id] = run.status
        nextRuns.push(run)
      }
    if (!signal.aborted && epoch === readEpoch) {
      statuses.value = next
      runs.value = nextRuns
      verified.value = true
    }
  } catch {
    if (!signal.aborted && epoch === readEpoch) verified.value = false
  } finally {
    refreshing = false
    const again = refreshAgain
    refreshAgain = false
    if (again || (signal.aborted && !abort.signal.aborted)) void refresh(again)
  }
}
async function act(workflow: WorkflowChatReference, action: 'test' | 'start' | 'stop' | 'stop_after_step') {
  if (props.disabled || props.readOnly || acting.value) return
  if (props.hostOnly) {
    emit('action', workflow, action)
    return
  }
  acting.value = true
  error.value = ''
  const signal = abort.signal
  try {
    if (action === 'stop_after_step') {
      if (!workflow.runId || boundaryPending(workflow) || isTerminalWorkflow(statusFor(workflow))) return
      const { stopWorkflowAfterStep } = await import('@/services/workflows/api')
      const result = await stopWorkflowAfterStep(props.projectId, workflow.id, workflow.runId, signal)
      if (!signal.aborted) {
        readEpoch++
        const current = runFor(workflow)
        if (current) {
          runs.value = runs.value.map(run =>
            run.id !== current.id
              ? run
              : result.id === current.id
                ? result
                : Object.assign({}, current, { root_budget: result })
          )
          verified.value = true
        }
        await refresh(true)
      }
      return
    }
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
    await refresh(true)
  } catch (failure) {
    if (!signal.aborted)
      error.value =
        String(failure instanceof Error ? failure.message : 'Aktion fehlgeschlagen.') +
        ' Öffne den Workflow für Eingaben und Details.'
  } finally {
    if (!signal.aborted) acting.value = false
  }
}
watch(
  () => [props.projectId, props.workflows.map(item => item.id + '/' + (item.runId ?? '')).join(',')] as const,
  () => {
    abort.abort()
    abort = new AbortController()
    verified.value = false
    statuses.value = {}
    runs.value = []
    acting.value = false
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
function clearAccount() {
  abort.abort()
  abort = new AbortController()
  statuses.value = {}
  runs.value = []
  verified.value = false
  acting.value = false
  error.value = ''
}
if (typeof window !== 'undefined') window.addEventListener('luczor:api-identity-changing', clearAccount)
onBeforeUnmount(() => {
  abort.abort()
  if (timer) clearInterval(timer)
  if (typeof window !== 'undefined') window.removeEventListener('luczor:api-identity-changing', clearAccount)
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
        <span v-if="statusFor(workflow)"
          >{{ workflowStatusLabel(statusFor(workflow)) }}{{ currentVerified ? '' : ' · letzter bekannter Stand' }}</span
        >
        <WorkflowRunBudget
          v-if="runFor(workflow)"
          :run="runFor(workflow)!"
          :known-runs="displayedRuns"
          :stale="!currentVerified"
        />
      </div>
      <footer>
        <button type="button" @click="emit('open', workflow)">Öffnen</button>
        <button type="button" :disabled="disabled || readOnly || acting" @click="act(workflow, 'test')">Testen</button>
        <button type="button" :disabled="disabled || readOnly || acting" @click="act(workflow, 'start')">
          Starten
        </button>
        <button
          v-if="workflow.runId && !isTerminalWorkflow(statusFor(workflow))"
          type="button"
          :disabled="
            disabled || readOnly || acting || boundaryPending(workflow) || statusFor(workflow) === 'cancelling'
          "
          @click="act(workflow, 'stop_after_step')"
        >
          {{ boundaryPending(workflow) ? 'Halt angefordert' : 'Nach diesem Schritt stoppen' }}
        </button>
        <button
          v-if="workflow.runId && !isTerminalWorkflow(statusFor(workflow))"
          type="button"
          :disabled="disabled || readOnly || acting || statusFor(workflow) === 'cancelling'"
          @click="act(workflow, 'stop')"
        >
          Sofortigen Stopp anfordern
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
