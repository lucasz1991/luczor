import { reactive } from 'vue'
import { getChatPlaygroundState } from '@/services/chatPlayground'

/** Local presentation only. Page contents and URLs are never persisted. */
export const browserPanel = reactive({
  expanded: false,
  projectId: '',
  conversationId: '',
  viewMode: 'mini' as 'mini' | 'window',
  detached: false,
  detachedSessionId: '',
  error: '',
})

export function revealBrowserPanel(projectId: string, conversationId = ''): void {
  browserPanel.projectId = projectId
  browserPanel.conversationId = conversationId
  const playground = getChatPlaygroundState(projectId, conversationId)
  const browserTab = playground.tabs.find(tab => tab.kind === 'browser')
  if (browserTab) playground.activeTabId = browserTab.id
  browserPanel.expanded = true
}

export { browserFailure } from './browserFailure'
