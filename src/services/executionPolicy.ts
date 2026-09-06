import { Store } from '@tauri-apps/plugin-store'
import type { LuczorMode } from '@/services/openrouter.service'
import type { ToolEffect, ToolRisk, ToolScope } from '@/services/tools/types'

const SETTINGS_FILE = 'luczor.settings.json'

export const AUTO_EXECUTE_MUTATING_TOOLS_KEY = 'auto_execute_mutating_tools'

export type ExecutionPolicy = Readonly<{
  autoExecuteMutatingTools: boolean
}>

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = Object.freeze({
  autoExecuteMutatingTools: false,
})

/**
 * Read the local execution policy fail-closed. A missing, malformed, or
 * temporarily unreadable setting must never silently enable auto execution.
 */
export async function loadExecutionPolicy(): Promise<ExecutionPolicy> {
  try {
    const store = await Store.load(SETTINGS_FILE)
    const autoExecute = await store.get<unknown>(AUTO_EXECUTE_MUTATING_TOOLS_KEY)
    return {
      autoExecuteMutatingTools: autoExecute === true,
    }
  } catch {
    return DEFAULT_EXECUTION_POLICY
  }
}

export type AutoExecutionCandidate = Readonly<{
  mode: LuczorMode
  mutating: boolean
  requiresApproval: boolean
  risk?: ToolRisk
  scope?: ToolScope
  effects?: ToolEffect[]
}>

/**
 * Auto execution is deliberately narrower than unrestricted mode: it only
 * replaces the per-call approval for mutating tools that are already allowed
 * in act mode. Observe mode and non-mutating-but-sensitive approvals are not
 * bypassed here; the global kill switch remains enforced by the agent loop.
 */
export function canAutoExecuteTool(policy: ExecutionPolicy, candidate: AutoExecutionCandidate): boolean {
  return (
    policy.autoExecuteMutatingTools &&
    candidate.mode === 'act' &&
    candidate.mutating &&
    candidate.requiresApproval &&
    candidate.scope === 'project' &&
    candidate.risk !== 'critical' &&
    !!candidate.effects?.length &&
    candidate.effects.every(effect => effect === 'read' || effect === 'write')
  )
}
