import { Store } from '@tauri-apps/plugin-store'

export const DEFAULT_TOOL_LIMITS = { chat: 6, agent: 12 } as const
export const MAX_TOOL_ROUNDS = 64
export function validToolRounds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TOOL_ROUNDS
}
export async function loadToolLimits(): Promise<{ chat: number; agent: number }> {
  try {
    const store = await Store.load('luczor.settings.json')
    const chat = await store.get<unknown>('chat_tool_rounds')
    const agent = await store.get<unknown>('agent_tool_rounds')
    return {
      chat: validToolRounds(chat) ? chat : DEFAULT_TOOL_LIMITS.chat,
      agent: validToolRounds(agent) ? agent : DEFAULT_TOOL_LIMITS.agent,
    }
  } catch {
    return { ...DEFAULT_TOOL_LIMITS }
  }
}
