import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STATE } from '@/state/defaults'
import { mutations, state } from '@/state/store'
import { createChatSpace, isStandaloneChat, validateProjectName } from '@/services/chatNavigation'

const native = vi.hoisted(() => ({ isTauri: vi.fn(), save: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: native.isTauri }))
vi.mock('@/services/persistence', () => ({ saveAppStateStrict: native.save }))

beforeEach(() => {
  mutations.hydrate(structuredClone(DEFAULT_STATE))
  mutations.ensureDefaults()
  native.isTauri.mockReturnValue(true)
  native.save.mockReset().mockResolvedValue(undefined)
})

describe('project and standalone chat creation', () => {
  it('validates names before adding state and creates exactly one initial chat', async () => {
    const count = state.projects.length
    for (const name of ['', '   ', 'x'.repeat(161), 'test\u0000name'])
      await expect(createChatSpace({ name })).rejects.toThrow('Projektnamen')
    expect(state.projects).toHaveLength(count)
    expect(native.save).not.toHaveBeenCalled()
    expect(validateProjectName('  Planung  ')).toBe('Planung')
    const id = await createChatSpace({ name: '  Planung  ' })
    expect(state.projects.find(project => project.id === id)).toMatchObject({ name: 'Planung', goals: [] })
    expect(isStandaloneChat(state.projects.find(project => project.id === id))).toBe(false)
    expect(state.conversations?.filter(chat => chat.projectId === id)).toHaveLength(1)
    expect(state.global.ui?.lastProjectId).toBe(id)
    expect(native.save).toHaveBeenCalledOnce()
  })

  it('gives every standalone chat an independent context, draft and settings after hydration', async () => {
    const original = state.projects[0]!
    original.summary = 'Existing project context'
    const first = await createChatSpace({
      standalone: true,
      settings: { routeMode: 'local', thinkingTier: 'balanced' },
    })
    const firstId = mutations.getActiveConversationId(first)
    mutations.getConversation(firstId)!.draft = 'Unsent first draft'
    mutations.addMessage(mutations.makeMsg('user', 'Only in the first chat', first, firstId))
    const second = await createChatSpace({ standalone: true })
    mutations.hydrate(JSON.parse(JSON.stringify(state)))
    expect(first).not.toBe(second)
    expect(state.projects.filter(isStandaloneChat)).toHaveLength(2)
    expect(state.projects.find(project => project.id === first)).toMatchObject({
      summary: '',
      goals: [],
      kind: 'standalone-chat',
    })
    expect(mutations.getConversation(firstId)).toMatchObject({
      draft: 'Unsent first draft',
      settings: { routeMode: 'local' },
    })
    expect(mutations.getProjectMessages(second).some(message => message.content === 'Only in the first chat')).toBe(
      false
    )
    expect(mutations.getConversation(mutations.getActiveConversationId(second))?.draft).toBeUndefined()
    expect(state.projects.find(project => project.id === original.id)?.summary).toBe('Existing project context')
  })

  it('rolls back failed native persistence without switching selection or leaving orphan records', async () => {
    const before = JSON.parse(JSON.stringify(state))
    native.save.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(createChatSpace({ standalone: true })).rejects.toThrow('Disk unavailable')
    expect(JSON.parse(JSON.stringify(state))).toEqual(before)
  })

  it('keeps browser preview usable without claiming native persistence', async () => {
    native.isTauri.mockReturnValue(false)
    const id = await createChatSpace({ name: 'Preview' })
    expect(state.global.ui?.lastProjectId).toBe(id)
    expect(native.save).not.toHaveBeenCalled()
  })

  it('archives standalone chats without recreating an empty sidebar row after reload', async () => {
    const id = await createChatSpace({ standalone: true })
    const chatId = mutations.getActiveConversationId(id)
    mutations.addMessage(mutations.makeMsg('user', 'Recoverable history', id, chatId))
    mutations.deleteConversation(id, chatId)
    mutations.hydrate(JSON.parse(JSON.stringify(state)))
    expect(state.projects.find(project => project.id === id)?.archivedAt).toBeTruthy()
    expect(state.conversations?.filter(chat => chat.projectId === id && !chat.archivedAt)).toHaveLength(0)
    expect(state.messages.some(message => message.content === 'Recoverable history')).toBe(true)
    expect(state.global.ui?.lastProjectId).not.toBe(id)
  })
})
