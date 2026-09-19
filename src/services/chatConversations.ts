import type { AppState, Conversation } from '@/state/types'
import { getSafeRecordValue, isSafeRecordKey, setSafeRecordValue } from '@/services/safeRecord'

/** Stable across devices: importing a legacy project cannot create another first chat. */
export const legacyConversationId = (projectId: string): string => `legacy:${projectId}`

export function migrateConversations(state: AppState): void {
  if (!Array.isArray(state.conversations)) state.conversations = []
  const validChats = state.conversations.filter(
    chat => chat && typeof chat.id === 'string' && typeof chat.projectId === 'string' && typeof chat.title === 'string'
  )
  if (validChats.length !== state.conversations.length) state.conversations = validChats
  state.global.ui ??= {}
  state.global.ui.lastConversationByProject ??= {}
  for (const project of state.projects) {
    if (!isSafeRecordKey(project.id)) continue
    const legacyId = legacyConversationId(project.id)
    for (const message of state.messages.filter(item => item.projectId === project.id)) {
      if (!message.conversationId && message.meta?.conversationId) message.conversationId = message.meta.conversationId
      const linked = state.conversations.find(chat => chat.id === message.conversationId)
      if (linked && linked.projectId !== project.id) message.conversationId = undefined
      if (message.conversationId && !linked) {
        state.conversations.push({
          id: message.conversationId,
          projectId: project.id,
          title: message.role === 'user' ? message.content.trim().slice(0, 80) || 'Chat' : 'Chat',
          createdAt: message.createdAt,
          updatedAt: project.updatedAt,
          archivedAt: null,
        })
      }
    }
    const unassigned = state.messages.filter(message => message.projectId === project.id && !message.conversationId)
    let chats = state.conversations.filter(chat => chat.projectId === project.id)
    if (unassigned.length || !chats.length) {
      if (!chats.some(chat => chat.id === legacyId)) {
        const first = unassigned.find(message => message.role === 'user')
        const chat: Conversation = {
          id: legacyId,
          projectId: project.id,
          title: first?.content.trim().slice(0, 80) || 'Erster Chat',
          createdAt: unassigned[0]?.createdAt ?? project.createdAt,
          updatedAt: project.updatedAt,
          archivedAt: null,
        }
        state.conversations.push(chat)
        chats = [...chats, chat]
      }
      for (const message of unassigned) message.conversationId = legacyId
    }
    for (const call of getSafeRecordValue(state.pending?.toolCallsByProject ?? {}, project.id) ?? [])
      call.conversationId ??= legacyId
    const selected = getSafeRecordValue(state.global.ui.lastConversationByProject, project.id)
    if (!chats.some(chat => chat.id === selected && !chat.archivedAt)) {
      let chat = chats.find(item => !item.archivedAt)
      if (!chat && chats.length) {
        chat = chats[0]
        if (chat) chat.archivedAt = null
      }
      if (chat) setSafeRecordValue(state.global.ui.lastConversationByProject, project.id, chat.id)
    }
    // Goals moved from the project to its chats: hand a legacy project goal run to the selected chat once.
    if (project.autonomousGoal) {
      const selectedId = getSafeRecordValue(state.global.ui.lastConversationByProject, project.id)
      const target = chats.find(chat => chat.id === selectedId) ?? chats[0]
      if (target && !target.autonomousGoal) {
        target.autonomousGoal = { ...project.autonomousGoal, active: false, status: 'waiting' }
        target.goal ??= project.autonomousGoal.text
      }
      delete project.autonomousGoal
    }
  }
  state.conversationSchemaVersion = 1
}
