import { reactive } from 'vue'

export type ChatPlaygroundTab = {
  id: string
  kind: 'files' | 'browser' | 'terminal' | 'file'
  title: string
  path?: string
  url?: string
  content?: string
  loading?: boolean
  error?: string
}

export type ChatPlaygroundState = {
  tabs: ChatPlaygroundTab[]
  activeTabId: string
  expandedDirectories: Set<string>
  directories: Map<string, Array<{ path: string; name: string; kind: string; bytes: number }>>
}

const scopedPlaygrounds = new Map<string, ChatPlaygroundState>()

export function chatPlaygroundToolSessionId(projectId: string, conversationId: string): string {
  return `chat-playground:${JSON.stringify([projectId, conversationId])}`
}

function initialState(): ChatPlaygroundState {
  return reactive({
    tabs: [
      { id: 'files', kind: 'files', title: 'Dateien' },
      { id: 'browser', kind: 'browser', title: 'Browser' },
      { id: 'terminal', kind: 'terminal', title: 'Terminal' },
    ],
    activeTabId: 'files',
    expandedDirectories: new Set<string>(),
    directories: new Map(),
  })
}

export function getChatPlaygroundState(projectId: string, conversationId: string): ChatPlaygroundState {
  const key = JSON.stringify([projectId, conversationId])
  let state = scopedPlaygrounds.get(key)
  if (!state) {
    state = initialState()
    scopedPlaygrounds.set(key, state)
  }
  return state
}

export function appendPlaygroundTab(state: ChatPlaygroundState, tab: ChatPlaygroundTab): void {
  const existing = state.tabs.find(item => item.id === tab.id)
  if (existing) {
    Object.assign(existing, tab)
  } else {
    state.tabs.push(tab)
  }
  state.activeTabId = tab.id
}

export function setPlaygroundDirectory(
  state: ChatPlaygroundState,
  path: string,
  entries: Array<{ path: string; name: string; kind: string; bytes: number }>
): void {
  state.directories.set(path, entries)
}

export function closePlaygroundTab(state: ChatPlaygroundState, tabId: string): void {
  if (tabId === 'files') return
  const index = state.tabs.findIndex(tab => tab.id === tabId)
  if (index < 0) return
  state.tabs.splice(index, 1)
  if (state.activeTabId === tabId) state.activeTabId = state.tabs[Math.max(0, index - 1)]?.id ?? 'files'
}
