import type { ToolDef } from '@/services/tools/types'
import type { SharedDataPolicy } from './dataPolicy'

/** Egress restrictions do not make approved built-in tool evidence volatile. */
export function toolRetentionPolicy(tool: ToolDef, registeredBuiltIn: boolean): SharedDataPolicy {
  if (tool.retentionPolicy) return tool.retentionPolicy
  if (tool.dataHandling !== 'ephemeral') return 'syncable'
  return registeredBuiltIn ? 'local_only' : 'ephemeral'
}
