/** These records are local to the trusted desktop renderer. */
export type AgentPermission = 'read-only' | 'workspace-write'
export type AgentRole = 'planner' | 'implementer' | 'reviewer' | 'assistant'
export type AgentJobStatus = 'awaiting_approval' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Capture a verified principal and its canonical workspace together, before enqueueing. */
export type AgentProjectSnapshot = Readonly<{
  principalId: string
  projectId: string
  projectName: string
  rootPath?: string
  workspaceUpdatedAt?: number
}>

export type AgentJobInput = Readonly<{
  project: AgentProjectSnapshot
  adapterId: string
  prompt: string
  permission: AgentPermission
  role?: AgentRole
  model?: string
  externalThreadId?: string
}>

/** Suitable for local metadata history; never contains prompts, output or absolute paths. */
export type AgentJobMetadata = Readonly<{
  id: string
  principalId: string
  projectId: string
  adapterId: string
  model?: string
  role: AgentRole
  permission: AgentPermission
  status: AgentJobStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  externalThreadId?: string
  errorCode?: 'scope_changed' | 'execution_failed' | 'invalid_result'
}>

/** Live UI record; the prompt is intentionally absent, including while queued. */
export type AgentJob = Readonly<AgentJobMetadata & { project: AgentProjectSnapshot }>

export type AgentRunRequest = Readonly<{
  jobId: string
  project: AgentProjectSnapshot
  prompt: string
  permission: AgentPermission
  role: AgentRole
  model?: string
  externalThreadId?: string
  signal: AbortSignal
  /** Replace the live text with this complete output snapshot; the orchestrator bounds it. */
  onOutput: (output: string) => void
}>

export type AgentRunResult = Readonly<{
  output: string
  /** Only a real ID returned by the external runtime, never inferred from text. */
  externalThreadId?: string
}>

export type AgentAdapter = Readonly<{
  id: string
  permissions: readonly AgentPermission[]
  /** Must settle only after native cancellation has stopped the worker. */
  run: (request: AgentRunRequest) => Promise<AgentRunResult>
}>

export type AgentOrchestratorOptions = Readonly<{
  adapters: readonly AgentAdapter[]
  /** Recheck the current account, workspace binding, mode and kill switch. Throw to deny. */
  validateScope: (project: AgentProjectSnapshot, permission: AgentPermission) => void | Promise<void>
  onMetadata?: (metadata: AgentJobMetadata) => void
  maxConcurrent?: number
  maxPendingPerProject?: number
  maxPendingTotal?: number
  maxHistory?: number
  maxOutputCharacters?: number
  maxPromptCharacters?: number
  createId?: () => string
  now?: () => number
}>

/** Store locally; absolute workspace paths must never enter sync, memory or the shared archive. */
export type AgentProjectLink = Readonly<{
  principalId: string
  projectId: string
  adapterId: string
  externalThreadId: string
  workspaceRoot: string
  workspaceUpdatedAt?: number
  updatedAt: number
}>
