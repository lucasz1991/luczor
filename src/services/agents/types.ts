import type { ThinkingTier } from '@/services/inference/thinking'

export type AgentEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type AgentEffortSelection = Readonly<{
  tier: ThinkingTier
  model?: string
  requestedEffort?: AgentEffort
  appliedEffort?: AgentEffort
  status: 'requested' | 'confirmed' | 'unknown'
  reason: string
  capabilityRevision?: string
  capabilitySource?: 'codex-cache' | 'sdk-documentation' | 'runtime'
}>
export type AgentExecutionOptions = Readonly<{
  thinkingTier?: ThinkingTier
  effort?: AgentEffort
  effortSelection?: AgentEffortSelection
  executionProfile?: 'workspace' | 'host-user'
  maxTurns?: number
  maxBudgetUsd?: number
}>

/** These records are local to the trusted desktop renderer. */
export type AgentPermission = 'read-only' | 'workspace-write'
export type AgentRole = 'planner' | 'implementer' | 'reviewer' | 'join' | 'assistant'
export type AgentJobStatus =
  'awaiting_approval' | 'awaiting_external_approval' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Capture a verified principal and its canonical workspace together, before enqueueing. */
export type AgentProjectSnapshot = Readonly<{
  principalId: string
  projectId: string
  projectName: string
  rootPath?: string
  workspaceUpdatedAt?: number
}>

export type AgentJobInput = Readonly<
  AgentExecutionOptions & {
    project: AgentProjectSnapshot
    adapterId: string
    prompt: string
    permission: AgentPermission
    role?: AgentRole
    model?: string
    externalThreadId?: string
    teamRunId?: string
    teamNodeId?: string
  }
>

/** Suitable for local metadata history; never contains prompts, output or absolute paths. */
export type AgentJobMetadata = Readonly<
  AgentExecutionOptions & {
    id: string
    principalId: string
    projectId: string
    adapterId: string
    model?: string
    role: AgentRole
    permission: AgentPermission
    status: AgentJobStatus
    createdAt: number
    approvalExpiresAt?: number
    startedAt?: number
    finishedAt?: number
    externalThreadId?: string
    teamRunId?: string
    teamNodeId?: string
    errorCode?: 'scope_changed' | 'execution_failed' | 'invalid_result' | 'approval_expired'
  }
>

/** Live UI record; the prompt is intentionally absent, including while queued. */
export type AgentJob = Readonly<AgentJobMetadata & { project: AgentProjectSnapshot }>

export type AgentRunRequest = Readonly<
  AgentExecutionOptions & {
    jobId: string
    project: AgentProjectSnapshot
    prompt: string
    permission: AgentPermission
    role: AgentRole
    model?: string
    externalThreadId?: string
    teamRunId?: string
    teamNodeId?: string
    signal: AbortSignal
    /** Report a bounded lifecycle phase without exposing prompts or output. */
    onPhase?: (phase: 'running' | 'awaiting_external_approval') => void
    /** Replace the live text with this complete output snapshot; the orchestrator bounds it. */
    onOutput: (output: string) => void
  }
>

export type AgentRunResult = Readonly<{
  output: string
  effortSelection?: AgentEffortSelection
  /** Only a real ID returned by the external runtime, never inferred from text. */
  externalThreadId?: string
}>

export type AgentAdapter = Readonly<{
  id: string
  permissions: readonly AgentPermission[]
  /** Device resources that this adapter holds exclusively while its run settles. */
  exclusiveResources?: readonly string[]
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
  approvalTimeoutMs?: number
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
