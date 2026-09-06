import type { ChatActivity } from '@/services/chatActivity'
import type { ToolCallStatus } from '@/state/types'
import type { LuczorMode } from '@/services/inference/types'
import type { TokenUsage } from '@/services/tokenUsage'

export type MiniMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  question?: string
  choices: string[]
  createdAt: number
  status: 'running' | 'done' | 'failed' | 'canceled'
  activity?: ChatActivity
  tokenUsage?: TokenUsage
}
export type MiniTool = { id: string; name: string; detail: string; status: ToolCallStatus }
export type MiniDecision = {
  id: string
  kind: 'tool' | 'external'
  title: string
  description: string
  detail: string
}
export type MiniSnapshot = {
  sessionId: string
  revision: number
  project: { id: string; name: string } | null
  mode: LuczorMode
  busy: boolean
  mainBusy: boolean
  messages: MiniMessage[]
  tools: MiniTool[]
  decision: MiniDecision | null
  notice: string
  hud: { status: string; micLevel: number; killSwitch: boolean; reduceMotion?: boolean }
  mainDecision: MiniDecision | null
}
export type MiniAction =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'stop'; sessionId: string }
  | { type: 'reset'; sessionId: string }
  | { type: 'decide'; sessionId: string; id: string; approved: boolean }
  | { type: 'mode'; mode: 'observe' | 'act' }
  | { type: 'main_decide'; id: string; approved: boolean }
  | { type: 'kill_switch'; enabled: boolean }

export const MINI_ACTION_EVENT = 'luczor://mini-action'
export const MINI_STATE_EVENT = 'luczor://mini-state'
export const emptyMiniSnapshot = (): MiniSnapshot => ({
  sessionId: '',
  revision: 0,
  project: null,
  mode: 'observe',
  busy: false,
  mainBusy: false,
  messages: [],
  tools: [],
  decision: null,
  mainDecision: null,
  notice: '',
  hud: { status: 'idle', micLevel: 0, killSwitch: false },
})
