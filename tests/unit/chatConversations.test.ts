import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_STATE } from '@/state/defaults'
import { mutations, state } from '@/state/store'
import { migrateConversations, legacyConversationId } from '@/services/chatConversations'

beforeEach(() => mutations.hydrate(structuredClone(DEFAULT_STATE)))

describe('project conversations', () => {
  it('assigns legacy history once to a stable first chat without losing messages', () => {
    const legacy = structuredClone(DEFAULT_STATE)
    const project = legacy.projects[0]!
    legacy.messages = [
      {
        id: 'historic',
        projectId: project.id,
        content: 'Existing work',
        role: 'user',
        ts: 3,
        createdAt: 3,
        meta: {},
        parsed: null,
        visibility: 'visible',
      },
    ]
    migrateConversations(legacy)
    migrateConversations(legacy)
    expect(legacy.conversations).toHaveLength(1)
    expect(legacy.messages[0]).toMatchObject({
      id: 'historic',
      content: 'Existing work',
      conversationId: legacyConversationId(project.id),
    })
  })

  it('keeps messages and late tool outcomes in the captured conversation while navigation changes', () => {
    const project = state.projects[0]!.id
    const first = mutations.getActiveConversationId(project)
    const firstMessage = mutations.makeMsg('assistant', 'partial', project, first)
    mutations.addMessage(firstMessage)
    const second = mutations.createConversation(project)
    mutations.addMessage(mutations.makeMsg('user', 'Different subject', project, second.id))
    mutations.patchMessage(project, firstMessage.id, { content: 'Completed in background', conversationId: second.id })
    mutations.addHiddenToolMessage(project, { ok: true }, { conversationId: first, runId: 'captured-run' })
    expect(mutations.getActiveConversationId(project)).toBe(second.id)
    expect(mutations.getConversationMessages(project, second.id)).toHaveLength(1)
    expect(mutations.getConversationMessages(project, first, { includeHidden: true })).toHaveLength(2)
    expect(state.messages.find(message => message.id === firstMessage.id)?.conversationId).toBe(first)
    expect(state.messages.find(message => message.role === 'tool')?.meta.runId).toBe('captured-run')
  })

  it('preserves separate chat titles and selected chat through persistence hydration', () => {
    const project = state.projects[0]!.id
    const next = mutations.createConversation(project, 'Analysis')
    mutations.renameConversation(project, next.id, '  Device review  ')
    next.draft = 'Draft in this conversation'
    mutations.hydrate(JSON.parse(JSON.stringify(state)))
    expect(mutations.getActiveConversationId(project)).toBe(next.id)
    expect(state.conversations?.find(chat => chat.id === next.id)).toMatchObject({
      title: 'Device review',
      draft: 'Draft in this conversation',
    })
  })
  it('recovers imported conversation messages even when an older snapshot omitted chat metadata', () => {
    const project = state.projects[0]!.id
    const message = mutations.makeMsg('user', 'Imported topic', project, 'imported-chat')
    const snapshot = JSON.parse(JSON.stringify(state))
    snapshot.conversations = []
    snapshot.messages = [message]
    mutations.hydrate(snapshot)
    expect(state.conversations?.find(chat => chat.id === 'imported-chat')?.title).toBe('Imported topic')
    expect(mutations.getConversationMessages(project, 'imported-chat')).toHaveLength(1)
  })
})
