import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { runAgent, buildSystemPreamble } from '@/services/agent'
import { createMiniChatController } from '@/services/miniChat/controller'
import { MINI_ACTION_EVENT, type MiniAction, type MiniDecision, type MiniSnapshot } from '@/services/miniChat/types'
import type { LuczorMode } from '@/services/inference/types'
import { setStatus } from '@/state/hud'
import { localAssistantProfilePrompt, refreshAssistantProfile } from '@/services/assistantProfile'

type Dependencies = {
  context: () => { project: { id: string; name: string } | null; mode: LuczorMode; mainBusy: boolean }
  setMode: (mode: 'observe' | 'act') => void
  telemetry: () => MiniSnapshot['hud']
  mainDecision: () => MiniDecision | null
  decideMain: (id: string, approved: boolean) => void
  killSwitch: (enabled: boolean) => void
}
export function useMiniChatHost(deps: Dependencies) {
  const controller = createMiniChatController({
    context: deps.context,
    setMode: deps.setMode,
    preamble: buildSystemPreamble,
    run: async options => {
      try {
        const profile = await refreshAssistantProfile()
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        const prompt = localAssistantProfilePrompt(profile)
        return await runAgent({
          ...options,
          baseMessages: options.baseMessages.map(message =>
            message.role === 'system' && prompt ? { ...message, content: `${message.content}\n\n${prompt}` } : message
          ),
        })
      } finally {
        if (!deps.context().mainBusy && ['thinking', 'executing'].includes(deps.telemetry().status)) setStatus('idle')
      }
    },
  })
  const browserVisible = ref(!isTauri())
  const error = ref('')
  let unlisten: UnlistenFn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const snapshot = computed<MiniSnapshot>(() => ({
    ...controller.state,
    hud: deps.telemetry(),
    mainDecision: deps.mainDecision(),
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
    return controller.dispatch(action)
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
    window.addEventListener('luczor:voice-stop', controller.reset)
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
    publish()
    disposed = true
    unlisten?.()
    window.removeEventListener('luczor:voice-stop', controller.reset)
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
