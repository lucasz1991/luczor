import { chatRuns } from '@/services/chatRunManager'
import { createChatEffectJournal } from '@/services/chatEffectJournal'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { runAgent, buildSystemPreamble } from '@/services/agent'
import { modelUsageSettings } from '@/services/inference/modelUsageSettings'
import { createMiniChatController } from '@/services/miniChat/controller'
import { MINI_ACTION_EVENT, type MiniAction, type MiniDecision, type MiniSnapshot } from '@/services/miniChat/types'
import type { LuczorMode } from '@/services/inference/types'
import { setStatus } from '@/state/hud'
import { localAssistantProfilePrompt, refreshAssistantProfile } from '@/services/assistantProfile'
import { createMiniChatBridge, type MiniWorkspaceBinding } from '@/services/miniChat/bridge'
import { resolveWorkspacePrincipalId } from '@/services/projectWorkspace'
import { executionGate } from '@/services/executionGate'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { loadPendingTaskCreates, replacePendingTaskCreates } from '@/services/agents/taskCreateRecoveryLedger'

type Dependencies = MiniWorkspaceBinding & {
  context: () => {
    project: { id: string; name: string } | null
    mode: LuczorMode
    mainBusy: boolean
    workspaceBindingId?: string
  }
  setMode: (mode: 'observe' | 'act') => void
  telemetry: () => MiniSnapshot['hud']
  mainDecision: () => MiniDecision | null
  decideMain: (id: string, approved: boolean) => void
  killSwitch: (enabled: boolean) => void
  agentMode: () => boolean
  voice: () => MiniSnapshot['voice']
  appearance: () => NonNullable<MiniSnapshot['appearance']>
  /** System metrics for the nudge's Systemstatus pane; null while nobody watches. */
  system?: () => MiniSnapshot['system']
  /** The nudge started/stopped watching the Systemstatus pane. */
  watchSystem?: (active: boolean) => void
}
export function useMiniChatHost(deps: Dependencies) {
  const controller = createMiniChatController({
    followProject: true,
    context: deps.context,
    setMode: deps.setMode,
    preamble: (mode, name) =>
      `${buildSystemPreamble(mode, name)}\nDu bist im übergeordneten Luczor-Workspace. Nutze workspace_overview für die Übersicht und workspace_* für ausdrücklich adressierte Projekte, Projektchats und verwaltete Agentenaufträge. Für workflow_* muss project_id immer ausdrücklich das vom Nutzer bestimmte verfügbare Zielprojekt benennen; frage bei unklarem Zielprojekt nach. Ein Workflow-Erstellungs- oder Verbesserungsauftrag startet keinen Lauf und aktiviert keinen Auslöser. Dateien und Desktopaktionen bleiben an das Arbeitsprojekt dieser Runde gebunden. Projektwechsel erfolgen zwischen Aufträgen. Codeaufträge werden vorbereitet und vom Nutzer im Agentenfenster geprüft und gestartet. Behaupte keine Ausführung oder Ergebnisse ohne Werkzeugnachweis.`,
    run: async options => {
      const ticket = options.execution ?? executionGate.capture(options.signal)
      const expectedLocalModelId = modelUsageSettings.value.localModelId
      const projectIds = deps.projects().map(project => project.id)
      try {
        const principalId = await resolveWorkspacePrincipalId()
        const account = await getVerifiedAccountSnapshot()
        executionGate.assert(ticket)
        return await chatRuns.submit(
          {
            principalId,
            projectId: options.projectId,
            conversationId: options.conversationId ?? `workspace:${options.runId ?? crypto.randomUUID()}`,
            runId: options.runId,
          },
          async handle => {
            const runExecution = { ...ticket, signal: AbortSignal.any([ticket.signal, handle.signal]) }
            executionGate.assert(runExecution)
            if (modelUsageSettings.value.localModelId !== expectedLocalModelId)
              throw new Error('Modellauswahl geändert. Bitte den Auftrag erneut starten.')
            const profile = await refreshAssistantProfile()
            executionGate.assert(ticket)
            if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
            const prompt = localAssistantProfilePrompt(profile)
            const principalScopeId = JSON.stringify([
              account?.serverInstance ?? 'device-local',
              account?.principalId ?? principalId,
            ])
            let taskCreateRecoveryReady = true
            const pendingTaskCreateVerifications = await loadPendingTaskCreates(
              principalScopeId,
              options.projectId
            ).catch(() => {
              taskCreateRecoveryReady = false
              return []
            })
            executionGate.assert(ticket)
            return await runAgent({
              ...options,
              effectJournal: createChatEffectJournal({
                principalId,
                projectId: options.projectId,
                conversationId: options.conversationId ?? `workspace:${handle.runId}`,
                runId: handle.runId,
              }),
              execution: runExecution,
              signal: runExecution.signal,
              onRunWaiting: waiting => handle.setWaiting(waiting),
              agentMode: deps.agentMode(),
              agentTeamPreset: 'local',
              workspaceScope: Object.freeze({ principalId, projectIds: Object.freeze(projectIds) }),
              principalScopeId,
              workspaceBindingId: options.workspaceBindingId ?? '',
              pendingTaskCreateVerifications,
              taskCreateRecoveryReady,
              contextEgress: 'local_only',
              routingSettings: { preference: 'local_only', localModelId: expectedLocalModelId },
              externalBaseMessages: undefined,
              requestExternalApproval: undefined,
              onCheckpoint: async checkpoint => {
                if (ticket.signal.aborted || checkpoint.principalScopeId !== principalScopeId) return
                await options.onCheckpoint?.(checkpoint)
                if (ticket.signal.aborted) return
                await replacePendingTaskCreates(
                  principalScopeId,
                  options.projectId,
                  checkpoint.pendingTaskCreateVerifications ?? []
                )
              },
              baseMessages: options.baseMessages.map(message =>
                message.role === 'system' && prompt
                  ? { ...message, content: `${message.content}\n\n${prompt}` }
                  : message
              ),
            })
          },
          ticket.signal
        )
      } finally {
        if (!deps.context().mainBusy && ['thinking', 'executing'].includes(deps.telemetry().status)) setStatus('idle')
      }
    },
  })
  const bridge = createMiniChatBridge(controller, deps)
  const browserVisible = ref(!isTauri())
  const error = ref('')
  let unlisten: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const snapshot = computed<MiniSnapshot>(() => ({
    ...bridge.snapshot.value,
    hud: deps.telemetry(),
    mainDecision: deps.mainDecision(),
    agentMode: deps.agentMode(),
    voice: deps.voice(),
    appearance: deps.appearance(),
    system: deps.system?.() ?? null,
  }))
  function dispatch(action: MiniAction) {
    if (action.type === 'main_decide') {
      deps.decideMain(action.id, action.approved)
      return
    }
    if (action.type === 'kill_switch') {
      deps.killSwitch(action.enabled)
      if (action.enabled) controller.stop()
      return
    }
    if (action.type === 'system_watch') {
      // The bridge session is what the nudge sees; stale windows must not start sampling.
      if (action.sessionId === bridge.snapshot.value.sessionId) deps.watchSystem?.(action.active)
      return
    }
    return bridge.dispatch(action)
  }
  function publish() {
    if (!isTauri() || disposed) return
    void invoke('mini_chat_publish', { snapshot: JSON.parse(JSON.stringify(snapshot.value)) }).catch(() => {
      error.value = 'Mini-Chat konnte nicht aktualisiert werden.'
    })
  }
  watch(
    () => deps.context(),
    () => controller.refresh(),
    { deep: true }
  )
  watch(
    snapshot,
    () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        publish()
      }, 120)
    },
    { deep: true }
  )
  onMounted(async () => {
    window.addEventListener('luczor:api-identity-changing', bridge.reset)
    if (!isTauri()) return
    try {
      const off = await listen<MiniAction>(MINI_ACTION_EVENT, event => {
        void dispatch(event.payload)
      })
      if (disposed) {
        off()
        return
      }
      unlisten = off
      publish()
      await invoke('mini_chat_open')
    } catch {
      error.value = 'Mini-Chat konnte nicht verbunden werden.'
    }
  })
  onBeforeUnmount(() => {
    controller.reset()
    bridge.dispose()
    publish()
    disposed = true
    unlisten?.()
    window.removeEventListener('luczor:api-identity-changing', bridge.reset)
    clearTimeout(timer)
  })
  async function open() {
    error.value = ''
    controller.refresh()
    if (!isTauri()) {
      browserVisible.value = true
      return
    }
    try {
      publish()
      await invoke('mini_chat_open')
    } catch {
      error.value = 'Mini-Fenster konnte nicht geöffnet werden. Bitte Luczor erneut starten.'
    }
  }
  return { ...controller, snapshot, browserVisible, error, open, dispatch }
}
