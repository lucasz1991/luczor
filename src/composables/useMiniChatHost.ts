import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { runAgent, buildSystemPreamble } from '@/services/agent'
import { createMiniChatController } from '@/services/miniChat/controller'
import { MINI_ACTION_EVENT, type MiniAction, type MiniDecision, type MiniSnapshot } from '@/services/miniChat/types'
import type { LuczorMode } from '@/services/inference/types'
import { setStatus } from '@/state/hud'
import { localAssistantProfilePrompt, refreshAssistantProfile } from '@/services/assistantProfile'
import { createMiniChatBridge, type MiniWorkspaceBinding } from '@/services/miniChat/bridge'
import { resolveWorkspacePrincipalId } from '@/services/projectWorkspace'
import { executionGate } from '@/services/executionGate'

type Dependencies = MiniWorkspaceBinding & {
  context: () => { project: { id: string; name: string } | null; mode: LuczorMode; mainBusy: boolean }
  setMode: (mode: 'observe' | 'act') => void
  telemetry: () => MiniSnapshot['hud']
  mainDecision: () => MiniDecision | null
  decideMain: (id: string, approved: boolean) => void
  killSwitch: (enabled: boolean) => void
  appearance: () => NonNullable<MiniSnapshot['appearance']>
}
export function useMiniChatHost(deps: Dependencies) {
  const controller = createMiniChatController({
    followProject: true,
    context: deps.context,
    setMode: deps.setMode,
    preamble: (mode, name) =>
      `${buildSystemPreamble(mode, name)}\nDu bist im übergeordneten Luczor-Workspace. Nutze workspace_overview für die Übersicht und workspace_* für ausdrücklich adressierte Projekte, Projektchats und verwaltete Agentenaufträge. Dateien und Desktopaktionen bleiben an das Arbeitsprojekt dieser Runde gebunden. Projektwechsel erfolgen zwischen Aufträgen. Codeaufträge werden vorbereitet und vom Nutzer im Agentenfenster geprüft und gestartet. Behaupte keine Ausführung oder Ergebnisse ohne Werkzeugnachweis.`,
    run: async options => {
      const ticket = executionGate.capture(options.signal)
      const projectIds = deps.projects().map(project => project.id)
      try {
        const principalId = await resolveWorkspacePrincipalId()
        executionGate.assert(ticket)
        const profile = await refreshAssistantProfile()
        executionGate.assert(ticket)
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const prompt = localAssistantProfilePrompt(profile)
        return await runAgent({
          ...options,
          workspaceScope: Object.freeze({ principalId, projectIds: Object.freeze(projectIds) }),
          contextEgress: 'local_only',
          routingSettings: { preference: 'local_only' },
          externalBaseMessages: undefined,
          requestExternalApproval: undefined,
          baseMessages: options.baseMessages.map(message =>
            message.role === 'system' && prompt ? { ...message, content: `${message.content}\n\n${prompt}` } : message
          ),
        })
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
    appearance: deps.appearance(),
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
    window.addEventListener('luczor:voice-stop', bridge.reset)
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
    window.removeEventListener('luczor:voice-stop', bridge.reset)
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
