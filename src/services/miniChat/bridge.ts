import { computed, ref, watch } from 'vue'
import { boundMiniMessages } from './projectChat'
import type { createMiniChatController } from './controller'
import type { MiniAction, MiniMessage, MiniPanel, MiniProject, MiniSnapshot, MiniTool, MiniView } from './types'

export type MiniChatBinding = {
  key: string
  project: MiniSnapshot['project']
  messages: MiniMessage[]
  tools: MiniTool[]
  busy: boolean
}
export type MiniWorkspaceBinding = {
  projects: () => MiniProject[]
  chat: () => MiniChatBinding
  sendChat: (text: string, projectId: string) => Promise<void>
  stopChat: () => void | Promise<void>
  selectProject: (id: string) => void | Promise<void>
  openPanel: (panel: MiniPanel) => void | Promise<void>
  togglePushToTalk?: () => void | Promise<void>
  toggleWakeWord?: () => void | Promise<void>
  setAgentMode?: (enabled: boolean) => void | Promise<void>
}

/** One display, two explicit contexts. Actions always carry the current view epoch. */
export function createMiniChatBridge(
  controller: ReturnType<typeof createMiniChatController>,
  deps: MiniWorkspaceBinding
) {
  const view = ref<MiniView>('workspace')
  const sessionId = ref(crypto.randomUUID())
  const revision = ref(0)
  const notice = ref('')
  const selecting = ref(false)
  const busy = computed(() => controller.state.busy || deps.chat().busy || selecting.value)
  const rotate = () => {
    sessionId.value = crypto.randomUUID()
    notice.value = ''
  }
  const stopContextWatch = watch(() => `${view.value}:${deps.chat().key}`, rotate, { flush: 'sync' })
  const content = computed(() => {
    const chat = deps.chat()
    return {
      ...controller.state,
      view: view.value,
      sessionId: sessionId.value,
      projects: deps.projects().slice(0, 200),
      project: chat.project,
      messages: boundMiniMessages(view.value === 'chat' ? chat.messages : controller.state.messages),
      tools: view.value === 'chat' && !controller.state.busy ? chat.tools : controller.state.tools,
      busy: busy.value,
      mainBusy: controller.state.mainBusy && !chat.busy,
      notice: notice.value || (view.value === 'workspace' ? controller.state.notice : ''),
    }
  })
  const stopRevisionWatch = watch(content, () => revision.value++, { deep: true, flush: 'sync' })
  const snapshot = computed<MiniSnapshot>(() => ({ ...content.value, revision: revision.value }))
  async function dispatch(action: MiniAction) {
    if (action.type === 'ready') {
      controller.refresh()
      return
    }
    if ('sessionId' in action && action.sessionId !== sessionId.value) return
    if (action.type === 'view') {
      view.value = action.view
      return
    }
    if (action.type === 'stop') {
      if (controller.state.busy) controller.stop()
      else await deps.stopChat()
      return
    }
    if (action.type === 'decide') {
      return controller.dispatch({ ...action, sessionId: controller.state.sessionId })
    }
    if (action.type === 'voice_push_to_talk') {
      await deps.togglePushToTalk?.()
      return
    }
    if (action.type === 'voice_wake_word') {
      await deps.toggleWakeWord?.()
      return
    }
    if (action.type === 'agent_mode') {
      await deps.setAgentMode?.(action.enabled)
      return
    }
    if (action.type === 'select_project' || action.type === 'workspace_open') {
      if (busy.value || controller.state.mainBusy) {
        notice.value = 'Der aktuelle Auftrag läuft noch.'
        return
      }
      const epoch = sessionId.value
      selecting.value = true
      try {
        if (action.type === 'select_project') {
          if (!deps.projects().some(project => project.id === action.projectId))
            throw new Error('Projekt nicht verfügbar.')
          await deps.selectProject(action.projectId)
          controller.refresh()
        } else await deps.openPanel(action.panel)
      } catch (error) {
        if (sessionId.value === epoch) notice.value = error instanceof Error ? error.message : 'Aktion fehlgeschlagen.'
      } finally {
        selecting.value = false
      }
      return
    }
    if (action.type === 'reset') {
      // A fresh workspace conversation never deletes the shared project chat.
      if (view.value === 'chat') {
        view.value = 'workspace'
        return
      }
      controller.reset()
      rotate()
      return
    }
    if (action.type === 'send') {
      if (busy.value || controller.state.mainBusy || !action.text.trim() || action.text.length > 12_000) return
      notice.value = ''
      if (view.value === 'workspace') return controller.dispatch({ ...action, sessionId: controller.state.sessionId })
      const project = deps.chat().project
      if (!project) {
        notice.value = 'Wähle zuerst einen Projektchat.'
        return
      }
      const epoch = sessionId.value
      try {
        await deps.sendChat(action.text, project.id)
      } catch (error) {
        if (sessionId.value === epoch)
          notice.value = error instanceof Error ? error.message : 'Nachricht konnte nicht gesendet werden.'
      }
      return
    }
    return controller.dispatch(action)
  }
  return {
    snapshot,
    dispatch,
    reset() {
      controller.reset()
      rotate()
    },
    dispose() {
      stopContextWatch()
      stopRevisionWatch()
    },
  }
}
