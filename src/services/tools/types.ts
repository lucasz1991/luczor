export type ToolCategory = 'os' | 'project' | 'app' | 'custom'

/**
 * Controls what survives the current provider round. `ephemeral` results may
 * be shown to the model after an explicit approval, but are never persisted in
 * chat history or mirrored to the Laravel audit/archive.
 */
export type ToolDataHandling = 'syncable' | 'ephemeral'

export type ToolRisk = 'low' | 'sensitive' | 'critical'
export type ToolScope = 'app' | 'project' | 'desktop' | 'network'
export type ToolEffect = 'read' | 'write' | 'input' | 'execute'
export type ToolApprovalMode = 'call' | 'session'
export type ToolSessionKind = 'browser' | 'vision' | 'terminal' | 'model'

export type WorkspaceScope = { principalId: string; projectIds: readonly string[] }

export type ToolContext = {
  workflowScope?: import('@/services/workflows/browser').WorkflowArtifactScope
  projectId: string
  signal?: AbortSignal
  execution?: import('@/services/executionGate').ExecutionTicket
  inferenceTarget?: 'local' | 'external'
  workspaceScope?: WorkspaceScope
  /** Shared run identity used by the main window and the mini chat. */
  toolSessionId?: string
}

export type ToolDef = {
  /** Available only in a captured local workspace-management turn. */
  workspaceOnly?: boolean
  /** Stable machine name, e.g. "project_set_summary". Sent to the model. */
  name: string
  category: ToolCategory
  /** One-line description the model uses to decide when to call the tool. */
  description: string
  /** JSON Schema for the tool arguments (OpenRouter function.parameters). */
  parameters: Record<string, unknown>
  /** Mutating tools are hard-blocked while the app is in "observe" mode. */
  mutating: boolean
  /** When true, the user must approve the call before it executes. */
  requiresApproval: boolean
  /** Local/provider result retention policy. Defaults to `syncable`. */
  dataHandling?: ToolDataHandling
  /** Enforced by the execution policy as well as displayed in the audit/UI. */
  risk?: ToolRisk
  scope?: ToolScope
  effects?: ToolEffect[]
  /** Capability exposed by the Tool Center and device capability catalog. */
  capabilityKey?: string
  /** Optional native session family retained across related tool calls. */
  sessionKind?: ToolSessionKind
  /** Approval applies to one call or to the bounded session. */
  approvalMode?: ToolApprovalMode
  /** Execute the tool. Return value must be JSON-serializable. */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}
