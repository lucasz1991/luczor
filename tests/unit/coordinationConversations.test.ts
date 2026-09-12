import { beforeEach, describe, expect, it, vi } from 'vitest'
type TestMessage = { id: string; projectId: string; conversationId: string; role: string; content: string; createdAt: number; visibility?: string }
const mock = vi.hoisted(() => ({
  request: vi.fn(),
  save: vi.fn(),
  account: vi.fn(),
  active: vi.fn(),
  state: {
    projects: [] as Array<{ id: string; cloud: { principalId: string; externalId: string } }>,
    conversations: [] as Array<{ id: string; projectId: string; title: string; createdAt: number; updatedAt: number }>,
    messages: [] as TestMessage[],
  },
  entries: new Map<string, unknown>(),
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async () => ({
      get: async (key: string) => mock.entries.get(key),
      set: async (key: string, value: unknown) => mock.entries.set(key, value),
      save: mock.save,
    }),
  },
}))
vi.mock('@/state/store', () => ({
  state: mock.state,
  mutations: {
    getActiveConversationId: () => 'chat-1',
    addMessage: (message: TestMessage) => mock.state.messages.push(message),
  },
}))
vi.mock('@/services/chatRunManager', () => ({ chatRuns: { hasLive: mock.active } }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mock.account }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/persistence', () => ({ saveAppStateStrict: async () => {} }))
import { conversationWireId, syncConversations } from '@/services/coordination/conversations'
const messageId = '6146f48e-6ba0-4f19-a15a-730705dba0a8'
let chatId: string
beforeEach(async () => {
  vi.clearAllMocks()
  mock.entries.clear()
  mock.account.mockResolvedValue({ principalId: 'account-1', config: { clientId: 'device', deviceKey: 'key' } })
  mock.state.projects = [{ id: 'local-project', cloud: { principalId: 'account-1', externalId: 'global-project' } }]
  mock.state.conversations = [{ id: 'chat-1', projectId: 'local-project', title: 'Test', createdAt: 10, updatedAt: 10 }]
  mock.state.messages = []
  chatId = await conversationWireId('account-1:global-project', 'chat-1')
  mock.active.mockReturnValue(false)
  mock.request.mockImplementation(async (path: string, options: { method: string }) => {
    if (path === '/conversations')
      return {
        data: [
          {
            external_id: chatId,
            title: 'Test',
            revision: 0,
            created_at: new Date(10).toISOString(),
            updated_at: new Date(10).toISOString(),
          },
        ],
      }
    if (options.method === 'GET') return { data: { revision: 0, messages: [], next_cursor: 0 } }
    return { data: { revision: 1 } }
  })
})
describe('append-only cross-device conversations', () => {
  it('terminates an empty backend page whose cursor stays unchanged', async () => {
    await syncConversations()
    expect(mock.request).toHaveBeenCalledTimes(2)
    expect(mock.save).toHaveBeenCalledOnce()
  })
  it('imports public results only after the local conversation finishes', async () => {
    mock.request.mockImplementation(async (path: string) =>
      path === '/conversations'
        ? {
            data: [
              {
                external_id: chatId,
                title: 'Test',
                revision: 1,
                created_at: new Date(10).toISOString(),
                updated_at: new Date(10).toISOString(),
              },
            ],
          }
        : {
            data: {
              revision: 1,
              messages: [{ id: messageId, role: 'assistant', content: 'Remote result', created_at: 20 }],
              next_cursor: 1,
            },
          }
    )
    mock.active.mockReturnValue(true)
    await syncConversations()
    expect(mock.state.messages).toHaveLength(0)
    mock.active.mockReturnValue(false)
    await syncConversations()
    await syncConversations()
    expect(mock.state.messages).toHaveLength(1)
    expect(mock.state.messages[0]!.conversationId).toBe('chat-1')
  })
  it('never overwrites conflicting message content with the same identity', async () => {
    mock.state.messages = [
      {
        id: messageId,
        projectId: 'local-project',
        conversationId: 'chat-1',
        role: 'user',
        content: 'Local',
        createdAt: 20,
      },
    ]
    mock.request.mockImplementation(async (path: string) =>
      path === '/conversations'
        ? {
            data: [
              {
                external_id: chatId,
                title: 'Test',
                revision: 1,
                created_at: new Date(10).toISOString(),
                updated_at: new Date(10).toISOString(),
              },
            ],
          }
        : {
            data: {
              revision: 1,
              messages: [{ id: messageId, role: 'user', content: 'Remote', created_at: 20 }],
              next_cursor: 1,
            },
          }
    )
    await expect(syncConversations()).rejects.toThrow('unterschiedliche Fassungen')
    expect(mock.state.messages[0]!.content).toBe('Local')
  })
  it('does not send hidden, streaming or other-account histories', async () => {
    mock.state.messages = [
      {
        id: messageId,
        projectId: 'local-project',
        conversationId: 'chat-1',
        role: 'assistant',
        content: 'Hidden',
        createdAt: 20,
        visibility: 'hidden',
      },
    ]
    mock.state.projects.push({ id: 'foreign', cloud: { principalId: 'account-2', externalId: 'other' } })
    await syncConversations()
    expect(mock.request.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
    expect(mock.request.mock.calls.some(([, options]) => options.query?.project_id === 'other')).toBe(false)
  })
})
