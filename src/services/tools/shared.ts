import { LuczorApi, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import { state } from '@/state/store'
import type { GoalStatus } from '@/state/types'

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function asGoalStatus(value: unknown): GoalStatus {
  return value === 'in_progress' || value === 'done' ? value : 'open'
}

export function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `g_${Math.random().toString(16).slice(2)}`
}

export function getProject(projectId: string) {
  return state.projects.find(project => project.id === projectId)
}

/**
 * Project goals/summary live in the local desktop state, while tasks and
 * conversations use the server tables. Keep the current external id aligned
 * before attaching a server-side child record; createProject is idempotent.
 */
export async function ensureCurrentProjectOnServer(
  projectId: string,
  signal?: AbortSignal,
  config?: LuczorApiConfigSnapshot
): Promise<void> {
  const project = getProject(projectId)
  signal?.throwIfAborted()
  await LuczorApi.createProject(projectId, project?.name ?? projectId, signal, config)
  signal?.throwIfAborted()
}
