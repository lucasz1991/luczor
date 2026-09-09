import { invoke } from '@tauri-apps/api/core'
import type { AgentProjectSnapshot } from './types'

export type AgentDefaultModel = Readonly<{ model: string; revision: string; source: string }>
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,159}$/u
const SHA = /^[a-f0-9]{64}$/u
// Native metadata probes have one 15s deadline and at most 2s of reader cleanup.
const TIMEOUT_MS = 18_000

/** Only a project-bound native configuration observation can resolve an omitted model. */
export async function resolveAgentDefaultModel(
  adapterId: 'codex' | 'claude',
  project: AgentProjectSnapshot
): Promise<AgentDefaultModel> {
  if (!project.rootPath || !Number.isFinite(project.workspaceUpdatedAt))
    throw new Error('agent_default_model_scope_required')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      invoke<unknown>('agent_default_model_resolve', {
        payload: {
          adapterId,
          principalId: project.principalId,
          projectId: project.projectId,
          expectedRootPath: project.rootPath,
          expectedWorkspaceUpdatedAt: project.workspaceUpdatedAt,
        },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('agent_default_model_timeout')), TIMEOUT_MS)
      }),
    ])
    const data = value as Record<string, unknown> | null
    if (
      !data ||
      data.status !== 'confirmed' ||
      typeof data.model !== 'string' ||
      !MODEL.test(adapterId === 'claude' ? data.model.replace(/\[1m\]$/u, '') : data.model) ||
      typeof data.revision !== 'string' ||
      !SHA.test(data.revision) ||
      typeof data.source !== 'string' ||
      !/^[a-zA-Z0-9_.:-]{1,80}$/u.test(data.source)
    )
      throw new Error('agent_default_model_unconfirmed')
    return Object.freeze({ model: data.model, revision: data.revision, source: data.source })
  } finally {
    if (timer) clearTimeout(timer)
  }
}
