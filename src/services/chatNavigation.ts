import { isTauri } from '@tauri-apps/api/core'
import { mutations, state } from '@/state/store'
import type { ConversationSettings, Project } from '@/state/types'
import { saveAppStateStrict } from '@/services/persistence'

export function isStandaloneChat(project: Pick<Project, 'kind'> | undefined): boolean {
  return project?.kind === 'standalone-chat'
}

export function validateProjectName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 160 || /[\u0000-\u001f\u007f]/u.test(name))
    throw new Error('Bitte einen Projektnamen mit 1 bis 160 Zeichen eingeben.')
  return name
}

/** Keep the existing run/memory scope contract, without inheriting any project or folder. */
export async function createChatSpace(options: {
  name?: string
  standalone?: boolean
  settings?: ConversationSettings
}): Promise<string> {
  const name = options.standalone ? 'Chat ohne Projekt' : validateProjectName(options.name ?? '')
  const id = crypto.randomUUID()
  mutations.addProject({ id, name, ...(options.standalone ? { kind: 'standalone-chat' as const } : {}) }, false)
  const conversationId = mutations.getActiveConversationId(id)
  mutations.renameConversation(id, conversationId, 'Neuer Chat')
  if (options.settings) mutations.updateConversationSettings(conversationId, options.settings)
  try {
    // Browser preview is intentionally in-memory, like its existing chats.
    if (isTauri()) await saveAppStateStrict(state)
  } catch (error) {
    mutations.rollbackProjectCreation(id)
    throw error
  }
  mutations.setActiveConversation(id, conversationId)
  return id
}
