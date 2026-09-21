import type { ChatActivity } from '@/services/chatActivity'
import type { ChatCommentary, ToolCallStatus } from '@/state/types'
import type { LuczorMode } from '@/services/inference/types'
import type { TokenUsage } from '@/services/tokenUsage'
import type { WorkflowChatReference } from '@/services/workflows/presentation'
import type { WorkflowRun } from '@/services/workflows/types'
import type { ThinkingTier, ThinkingBudgetProgress, ThinkingControlAction } from '@/services/inference/thinking'
import type { DeepReadonly } from 'vue'
import type { SystemMetrics } from '@/services/systemMetrics'
import type { SystemStatusAvailability, SystemStatusPoint } from '@/services/systemStatusMonitor'

export type MiniWorkflowReference = WorkflowChatReference & { projectId: string }
export type MiniWorkflowAction = 'test' | 'start' | 'stop' | 'stop_after_step'

export type MiniMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  question?: string
  choices: string[]
  createdAt: number
  status: 'running' | 'done' | 'failed' | 'canceled'
  activity?: ChatActivity
  commentary?: ChatCommentary[]
  tokenUsage?: TokenUsage
  contextLabel?: string
  workflows?: MiniWorkflowReference[]
}
export type MiniView = 'chat' | 'workspace'
export type MiniPanel = 'agents' | 'project_folder' | 'desktop' | 'planning' | 'workflows'
export type MiniProject = { id: string; name: string; messageCount: number; updatedAt: number; busy?: boolean }
export type MiniTool = { id: string; name: string; detail: string; status: ToolCallStatus }
export type MiniDecision = {
  id: string
  kind: 'tool' | 'external'
  title: string
  description: string
  detail: string
}
/** Display-only copy of the main window's system monitor for the nudge's Systemstatus pane. */
export type MiniSystemSnapshot = {
  sample: DeepReadonly<SystemMetrics> | null
  history: ReadonlyArray<DeepReadonly<SystemStatusPoint>>
  availability: SystemStatusAvailability
  lastUpdatedAt: number | null
  model: { name: string; label: string; state: string; running: boolean | null }
}
export type MiniSnapshot = {
  /** Present only while the nudge watches the Systemstatus pane; otherwise omitted to keep snapshots small. */
  system?: MiniSystemSnapshot | null
  workflowRuns?: WorkflowRun[]
  workflowRunsVerified?: boolean
  thinkingTier?: ThinkingTier
  thinkingBudget?: ThinkingBudgetProgress | null
  thinkingControlAck?: {
    controlId: string
    requestId: string
    progress?: ThinkingBudgetProgress
    error?: string
  } | null
  view: MiniView
  projects: MiniProject[]
  conversations?: Array<{ id: string; title: string; busy: boolean }>
  conversationId?: string
  appearance?: { accent: string; assistantName: string }
  sessionId: string
  revision: number
  project: { id: string; name: string } | null
  mode: LuczorMode
  busy: boolean
  agentMode: boolean
  voice: {
    wakeWord: boolean
    recording: boolean
    busy: boolean
  }
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
  | { type: 'view'; sessionId: string; view: MiniView }
  | { type: 'select_project'; sessionId: string; projectId: string }
  | { type: 'select_conversation'; sessionId: string; projectId: string; conversationId: string }
  | { type: 'new_conversation'; sessionId: string; projectId: string }
  | { type: 'workspace_open'; sessionId: string; panel: MiniPanel }
  | { type: 'workflow_open' | 'workflow_improve'; sessionId: string; messageId: string; workflowId: number }
  | {
      type: 'workflow_action'
      sessionId: string
      messageId: string
      workflowId: number
      action: MiniWorkflowAction
    }
  | { type: 'send'; sessionId: string; text: string }
  | { type: 'voice_push_to_talk'; sessionId: string }
  | { type: 'voice_wake_word'; sessionId: string }
  | { type: 'agent_mode'; sessionId: string; enabled: boolean }
  | { type: 'thinking_tier'; sessionId: string; tier: ThinkingTier }
  | {
      type: 'thinking_control'
      sessionId: string
      requestId: string
      controlId: string
      action: ThinkingControlAction
      sequence: number
    }
  | { type: 'stop'; sessionId: string }
  | { type: 'reset'; sessionId: string }
  | { type: 'decide'; sessionId: string; id: string; approved: boolean }
  | { type: 'mode'; mode: 'observe' | 'act' }
  | { type: 'main_decide'; id: string; approved: boolean }
  | { type: 'kill_switch'; enabled: boolean }
  /** The nudge asks the main window to sample system metrics while its Systemstatus pane is visible. */
  | { type: 'system_watch'; sessionId: string; active: boolean }

export const MINI_ACTION_EVENT = 'luczor://mini-action'
export const MINI_STATE_EVENT = 'luczor://mini-state'
export const emptyMiniSnapshot = (): MiniSnapshot => ({
  thinkingTier: 'balanced',
  thinkingBudget: null,
  view: 'workspace',
  projects: [],
  sessionId: '',
  revision: 0,
  project: null,
  mode: 'observe',
  busy: false,
  agentMode: false,
  voice: { wakeWord: false, recording: false, busy: false },
  mainBusy: false,
  messages: [],
  tools: [],
  decision: null,
  mainDecision: null,
  notice: '',
  hud: { status: 'idle', micLevel: 0, killSwitch: false },
})
