// src/services/tools/registry.ts
//
// Stable public registry for Luczor's agentic loop. Domain modules own the
// individual definitions; this file owns their public order and lookup API.

import { agentTools } from './agents'
import { agentJobTools } from './agentJobs'
import { agentTeamTools } from './agentTeams'
import { filesystemTools } from './filesystem'
import { localModelTools } from './localModel'
import { memoryTools } from './memory'
import { osTools } from './os'
import { planTools } from './plans'
import { projectCreationTools, projectStateTools } from './project'
import { taskTools } from './tasks'
import { workspaceTools } from './workspace'
import { workflowTools } from './workflows'
import type { ToolDef } from './types'

export { lastScreenshot } from './os'
export type { ToolCategory, ToolContext, ToolDef } from './types'

/**
 * Tool order is part of the model-facing contract. Keep domain groups in the
 * same sequence when adding or moving definitions.
 */
const TOOLS: ToolDef[] = [
  ...projectStateTools,
  ...filesystemTools,
  ...osTools,
  ...localModelTools,
  ...projectCreationTools,
  ...taskTools,
  ...agentTools,
  ...agentJobTools,
  ...agentTeamTools,
  ...planTools,
  ...workflowTools,
  ...memoryTools,
  ...workspaceTools,
]

const BY_NAME = new Map<string, ToolDef>(TOOLS.map(tool => [tool.name, tool]))

export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name)
}

export function listTools(): ToolDef[] {
  return TOOLS.slice()
}

/** Emit the OpenRouter/OpenAI "tools" array for a chat request. */
export function toOpenAITools() {
  return TOOLS.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
}
