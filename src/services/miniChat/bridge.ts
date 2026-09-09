import { computed, ref, watch } from 'vue'
import { executionGate } from '@/services/executionGate'
import {
  isThinkingTier,
  type ThinkingTier,
  type ThinkingBudgetProgress,
  type ThinkingControlAction,
} from '@/services/inference/thinking'
import { boundMiniMessages } from './projectChat'
import type { createMiniChatController } from './controller'
import type {
  MiniAction,
  MiniMessage,
  MiniPanel,
  MiniProject,
  MiniSnapshot,
  MiniTool,
  MiniView,
  MiniWorkflowAction,
  MiniWorkflowReference,
} from './types'

export type MiniChatBinding = {
  key: string
  project: MiniSnapshot['project']
  messages: MiniMessage[]
  tools: MiniTool[]
  busy: boolean
}
export type MiniWorkspaceBinding = {
  thinkingTier?: () => ThinkingTier
  thinkingBudget?: () => ThinkingBudgetProgress | null
  setThinkingTier?: (tier: ThinkingTier) => void
  controlThinking?: (
    requestId: string,
    action: ThinkingControlAction,
    sequence: number
  ) => Promise<ThinkingBudgetProgress>
  projects: () => MiniProject[]
  chat: () => MiniChatBinding
  sendChat: (text: string, projectId: string) => Promise<void>
  stopChat: () => void | Promise<void>
  selectProject: (id: string) => void | Promise<void>
  openPanel: (panel: MiniPanel) => void | Promise<void>
  openWorkflow?: (reference: MiniWorkflowReference) => void | Promise<void>
  runWorkflow?: (reference: MiniWorkflowReference, action: MiniWorkflowAction) => void | Promise<void>
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
      thinkingTier: view.value === 'chat' ? (deps.thinkingTier?.() ?? 'balanced') : controller.state.thinkingTier,
      thinkingBudget: view.value === 'chat' ? (deps.thinkingBudget?.() ?? null) : controller.state.thinkingBudget,
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
    if (action.type === 'thinking_tier') {
      if (!isThinkingTier(action.tier)) return
      if (view.value === 'chat') deps.setThinkingTier?.(action.tier)
      else return controller.dispatch({ ...action, sessionId: controller.state.sessionId })
      return
    }
    if (action.type === 'thinking_control') {
      if (snapshot.value.thinkingBudget?.requestId !== action.requestId || !busy.value) return
      const epoch = sessionId.value
      try {
        if (view.value === 'workspace') await controller.dispatch({ ...action, sessionId: controller.state.sessionId })
        else {
          const progress = await deps.controlThinking?.(action.requestId, action.action, action.sequence)
          if (epoch === sessionId.value && progress?.controlOutcome === 'stale')
            notice.value = 'Budgetstand aktualisiert. Bitte die gewünschte Aktion erneut wählen.'
        }
      } catch (error) {
        if (epoch === sessionId.value)
          notice.value = error instanceof Error ? error.message : 'Budgetsteuerung fehlgeschlagen.'
      }
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
    if (action.type === 'workflow_open' || action.type === 'workflow_improve' || action.type === 'workflow_action') {
      if (view.value !== 'chat' || busy.value || controller.state.mainBusy) return
      const chat = deps.chat()
      const reference = chat.messages
        .find(message => message.id === action.messageId && message.role === 'assistant')
        ?.workflows?.find(workflow => workflow.id === action.workflowId && workflow.projectId === chat.project?.id)
      if (!reference || !Number.isSafeInteger(action.workflowId) || action.workflowId <= 0 || !chat.project) return
      if (
        action.type === 'workflow_action' &&
        (controller.state.mode === 'observe' ||
          !['test', 'start', 'stop'].includes(action.action) ||
          (action.action === 'stop' &&
            (typeof reference.runId !== 'string' || !/^[a-f0-9-]{36}$/iu.test(reference.runId))))
      )
        return
      const projectId = chat.project.id
      const epoch = sessionId.value
      selecting.value = true
      try {
        if (action.type === 'workflow_open') await deps.openWorkflow?.({ ...reference })
        else if (action.type === 'workflow_action') {
          executionGate.assert(executionGate.capture(), true)
          await deps.runWorkflow?.({ ...reference }, action.action)
        } else {
          const run =
            typeof reference.runId === 'string' && /^[a-f0-9-]{36}$/iu.test(reference.runId)
              ? ` und den Lauf ${reference.runId}`
              : ' und relevante letzte Läufe'
          await deps.sendChat(
            `Verbessere mit mir Workflow ID ${reference.id} im aktuellen Projekt. Lies zuerst die aktuelle Definition${run}. Begründe Änderungen anhand meines Ziels und vorhandener Ergebnisse. Starte erst auf meinen ausdrücklichen Auftrag.`,
            projectId
          )
        }
      } catch (error) {
        if (sessionId.value === epoch)
          notice.value = error instanceof Error ? error.message : 'Workflow-Aktion fehlgeschlagen.'
      } finally {
        selecting.value = false
      }
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
