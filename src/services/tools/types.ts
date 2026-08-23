export type ToolCategory = 'os' | 'project' | 'app' | 'custom'

export type ToolContext = {
  projectId: string
}

export type ToolDef = {
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
  /** Execute the tool. Return value must be JSON-serializable. */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
}
