import type { ToolDef } from '@/services/tools/types'

/**
 * Which registered tools Claude may drive as the main model. A tool result becomes part of
 * the next provider request, so the decision follows the classification every tool already
 * carries for provider/server egress — it is never widened here:
 *
 * - `dataHandling: 'ephemeral'` or a non-syncable retention policy keeps a tool local. That
 *   covers workspace files, the repository graph, memory, the browser, the desktop and the
 *   agent launchers.
 * - Desktop/network scope, input or execute effects, critical risk and native sessions are
 *   excluded as well.
 *
 * What remains are the app's own shared records (project state, tasks, chats, plans) and the
 * shareable workflow definitions. A newly registered tool is offered only if its
 * classification is compatible.
 */
export function claudeMayUseTool(tool: ToolDef): boolean {
  if (tool.workspaceOnly) return false
  if ((tool.dataHandling ?? 'syncable') !== 'syncable') return false
  if (tool.retentionPolicy !== undefined && tool.retentionPolicy !== 'syncable') return false
  if (tool.risk === 'critical') return false
  if (tool.scope !== undefined && tool.scope !== 'app' && tool.scope !== 'project') return false
  if (tool.sessionKind !== undefined) return false
  if (tool.effects?.some(effect => effect !== 'read' && effect !== 'write')) return false
  return true
}

export function toolsForClaudeMain(tools: readonly ToolDef[]): ToolDef[] {
  return tools.filter(claudeMayUseTool)
}

/** Names the agent loop must neither offer nor execute in a Claude-led turn. */
export function claudeDisabledToolNames(tools: readonly ToolDef[]): string[] {
  return tools.filter(tool => !claudeMayUseTool(tool)).map(tool => tool.name)
}
