import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import BrowserPanel from '@/components/browser/BrowserPanel.vue'
import { browserPanel } from '@/services/browserPanel'
import {
  appendPlaygroundTab,
  chatPlaygroundToolSessionId,
  closePlaygroundTab,
  getChatPlaygroundState,
} from '@/services/chatPlayground'

const boundContext = {
  projectId: 'project',
  conversationId: 'chat',
  projectName: 'Projekt',
  workspaceName: 'Arbeitsbereich',
  workspaceReady: false,
  mode: 'observe' as const,
  killSwitch: false,
}

describe('browser panel presentation', () => {
  it('fully removes the workspace row when the browser is collapsed', async () => {
    browserPanel.expanded = false
    const html = await renderToString(createSSRApp(BrowserPanel, boundContext))
    expect(html).not.toContain('id="browser-panel"')
  })
  it('binds the Chat Playground to its chat and keeps Files, Browser and Terminal tabs available', async () => {
    browserPanel.expanded = true
    const html = await renderToString(createSSRApp(BrowserPanel, boundContext))
    expect(html).toContain('aria-label="Chat Playground"')
    expect(html).toContain('CHAT PLAYGROUND')
    expect(html).toContain('Dateien')
    expect(html).toContain('Browser')
    expect(html).toContain('Terminal')
    expect(html).toContain('aria-label="Tab hinzufügen"')
    expect(html).toContain('Chat Playground einklappen')
    expect(html).not.toContain('<iframe')
  })

  it('keeps the file tree tab permanent while user tabs can be opened and closed', () => {
    const state = getChatPlaygroundState('project-playground-test', 'chat-playground-test')
    expect(state.tabs[0]?.id).toBe('files')
    appendPlaygroundTab(state, { id: 'file:src/main.ts', kind: 'file', title: 'main.ts', path: 'src/main.ts' })
    expect(state.activeTabId).toBe('file:src/main.ts')
    closePlaygroundTab(state, 'file:src/main.ts')
    closePlaygroundTab(state, 'files')
    expect(state.tabs.map(tab => tab.id)).toEqual(['files', 'browser', 'terminal'])
    expect(state.activeTabId).toBe('terminal')
  })

  it('uses one owner identity for the main chat and detached playground, scoped by project and chat', () => {
    expect(chatPlaygroundToolSessionId('project', 'chat')).toBe(chatPlaygroundToolSessionId('project', 'chat'))
    expect(chatPlaygroundToolSessionId('project', 'chat')).not.toBe(
      chatPlaygroundToolSessionId('project', 'other-chat')
    )
    expect(chatPlaygroundToolSessionId('project', 'chat')).not.toBe(
      chatPlaygroundToolSessionId('other-project', 'chat')
    )
  })
})
