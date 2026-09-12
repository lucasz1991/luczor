import type { AppState, Conversation } from '@/state/types'
import { getSafeRecordValue, isSafeRecordKey, setSafeRecordValue } from '@/services/safeRecord'

/** Stable across devices: importing a legacy project cannot create another first chat. */
export const legacyConversationId = (projectId: string): string => `legacy:${projectId}`

export function migrateConversations(state: AppState): void {
  state.conversations ??= []
  state.global.ui ??= {}
  state.global.ui.lastConversationByProject ??= {}
  for (const project of state.projects) {
    if (!isSafeRecordKey(project.id)) continue
    const legacyId = legacyConversationId(project.id)
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
    const selected = getSafeRecordValue(state.global.ui.lastConversationByProject, project.id)
    if (!chats.some(chat => chat.id === selected && !chat.archivedAt)) {
      const chat = chats.find(item => !item.archivedAt)
      if (chat) setSafeRecordValue(state.global.ui.lastConversationByProject, project.id, chat.id)
    }
  }
  state.conversationSchemaVersion = 1
}
