// src/state/types.ts
import type { TokenUsage } from '@/services/tokenUsage'
import type { ChatActivity } from '@/services/chatActivity'

export type Id = string

/* =========================================================
 * Core chat types
 * ========================================================= */
export type ChatRole = 'user' | 'assistant' | 'tool'
export type MessageVisibility = 'visible' | 'hidden'

export type MessageMeta = {
  thinkingTier?: import('@/services/inference/thinking').ThinkingTier
  kind?: 'question' | 'statement'
  isLoading?: boolean

  // tool/backchannel linkage
  toolCallId?: Id
  toolName?: string

  // streamed envelope fields (assistant)
  summary?: string
  question?: string
  bullets?: string[]

  // server routing metadata (from X-Luczor-* headers)
  model?: string
  provider?: string
  useCase?: string
  inferenceTarget?: 'local_llama_cpp' | 'laravel_proxy'
  routeDecisionId?: string
  tokenUsage?: TokenUsage
  specialistOutcomes?: import('@/services/agents/externalSpecialists').SpecialistOutcome[]
  /** Public intermediate rounds and progress remain with their chat message. */
  commentary?: ChatCommentary[]
  activity?: ChatActivity

  // how a user turn was produced; drives the "Gesprochen" badge
  inputSource?: 'keyboard' | 'push_to_talk' | 'hands_free'

  // LLM run evaluation linkage
  llmRequestId?: string
  userFeedback?: 'up' | 'down' | null

  /** Ephemeral tool results remain device-local and are excluded from sync. */
  dataHandling?: 'syncable' | 'ephemeral'
  /** False until a generated answer has a final server-egress classification. */
  serverSpeechAllowed?: boolean
}

export type ChatCommentary = {
  id: string
  round: number
  content: string
  createdAt: number
  serverSpeechAllowed: boolean
}

export type Message = {
  id: Id
  projectId: Id

  role: ChatRole
  content: string

  ts: number
  createdAt: number

  // raw model output (optional; not necessarily shown)
  raw?: string

  // parsed structured output (if any). Keep generic because schema can evolve.
  parsed: unknown | null

  // whether UI should display it
  visibility: MessageVisibility

  meta: MessageMeta
}

/* =========================================================
 * Project management
 * ========================================================= */
export type GoalStatus = 'open' | 'in_progress' | 'done'
export type GoalPriority = 'low' | 'normal' | 'high'

export type ProjectGoal = {
  id: Id
  title: string
  description?: string
  status: GoalStatus
  priority?: GoalPriority

  createdAt: number
  updatedAt: number
  doneAt?: number | null
}

export type ProjectFocus = {
  activeTodoId: Id | null
  activeStepId: Id | null
}

export type ProjectDefaults = {
  maxOutputTokens: number
}

export type Project = {
  id: Id
  name: string

  /**
   * Optional human-readable "overall goal" (high-level)
   * Separate from structured goals[] list.
   */
  goal?: string

  /**
   * Structured goals with status.
   */
  goals: ProjectGoal[]

  /**
   * Short project summary maintained over time.
   */
  summary: string

  defaults: ProjectDefaults
  focus: ProjectFocus

  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

/* =========================================================
 * Memories / Summaries (optional but supported)
 * ========================================================= */
export type MemoryKind = 'rule' | 'todo_policy' | 'preference' | 'fact' | 'note'

export type MemorySource = {
  by: 'user' | 'assistant' | 'system'
}

export type MemoryItem = {
  id: Id
  projectId: Id | null

  kind: MemoryKind
  key: string
  value: string

  priority: 1 | 2 | 3 | 4 | 5
  active: boolean

  createdAt: number
  updatedAt: number
  source: MemorySource
}

export type SummaryItem = {
  id: Id
  projectId: Id
  text: string
  createdAt: number
}

/* =========================================================
 * Tool calling (pending approvals / results)
 * ========================================================= */
export type ToolCallStatus =
  | 'proposed' // waiting for user approval/execution
  | 'approved' // user approved, app may execute
  | 'executing' // app is executing
  | 'executed' // executed successfully
  | 'failed' // executed with error
  | 'rejected' // user rejected
  | 'canceled' // aborted by user/app

export type PendingToolCall = {
  id: Id
  projectId: Id

  /**
   * Tool name. Examples:
   * - "os.bash"
   * - "os.open_app"
   * - "project.set_summary"
   * - "project.upsert_goal"
   */
  name: string

  /**
   * Optional category for grouping in UI
   * (keeps "name" stable while UI can bucket tools).
   */
  category?: 'os' | 'project' | 'app' | 'custom'

  /**
   * Tool arguments as plain JSON.
   */
  args: Record<string, unknown>

  /** Preserve the execution-time retention boundary across registry changes. */
  dataHandling?: 'syncable' | 'ephemeral'

  /**
   * Whether user approval is required before execution.
   */
  requiresApproval: boolean

  status: ToolCallStatus

  createdAt: number
  updatedAt: number

  result?: ToolResult
}

export type ToolResult = {
  toolCallId: Id
  name: string

  ok: boolean

  /**
   * Raw payload returned by the host app/tool executor.
   */
  output?: unknown

  /**
   * Error info if ok=false
   */
  error?: string

  ts: number
}

/* =========================================================
 * Global app state
 * ========================================================= */
export type GlobalDefaults = {
  maxOutputTokens: number
}

export type GlobalUi = {
  lastProjectId?: Id
}

export type GlobalState = {
  defaults: GlobalDefaults
  memories: MemoryItem[]
  ui?: GlobalUi
}

export type PendingState = {
  toolCallsByProject: Record<Id, PendingToolCall[]>
}

export type AppState = {
  version: 1

  global: GlobalState

  projects: Project[]
  messages: Message[]

  // optional legacy / future features
  todos: any[]
  todoSteps: any[]
  projectMemories: any[]

  summaries: SummaryItem[]

  pending: PendingState

  /** Explicitly saved, redacted Tool-Center artifact references. */
  toolArtifacts?: import('@/services/tools/toolArtifacts').SavedToolArtifact[]
}
