// src/services/contextController.ts
//
// Client bridge to the server Context Controller (/api/v1/context/ask), which
// ranks + budgets memory into a small context package. Falls back to local
// memory when the server isn't used/reachable.

import { Store } from '@tauri-apps/plugin-store'
import { getApiConfig } from '@/services/api/luczorApi'
import { luczorMemory } from '@/services/memory/luczorMemory'

const SETTINGS_FILE = 'luczor.settings.json'

export type ContextPackage = {
  context_id: string
  project_id?: string
  repo_id?: string
  branch?: string
  commit_sha?: string
  task_type: string
  feature_key?: string
  budget: { max_input_tokens: number; estimated_tokens: number }
  code?: Array<{ path: string; reason: string; score: number; tokens?: number }>
  memory: Array<{ id?: string; content: string; type: string; staleness: string; score: number }>
  instructions: string[]
}

export type PromptContextDetails = {
  text: string
  contextId?: string
  repoId?: string
  branch?: string
  commitSha?: string
  taskType: string
}

export function inferTaskType(text: string): string {
  const t = text.toLowerCase()
  if (/\b(fix|bug|fehler|exception|stack|kaputt|crash|test|lint|build)\b/.test(t)) return 'coding.fix_bug'
  if (/\b(refactor|umbau|aufräumen|vereinfachen|struktur)\b/.test(t)) return 'coding.refactor'
  if (/\b(review|prüf|pruef|code review|risiko)\b/.test(t)) return 'coding.review'
  if (/\b(plan|planung|architektur|roadmap|konzept|entwurf)\b/.test(t)) return 'planning.architecture'
  if (/\b(browser|seite|klick|formular|screenshot)\b/.test(t)) return 'browser.automation'
  if (/\b(server|deploy|log|ssh|docker|datenbank|db)\b/.test(t)) return 'admin.server_debug'
  return 'chat.general'
}

async function serverTarget(): Promise<{ baseUrl: string; deviceKey: string } | null> {
  try {
    const s = await Store.load(SETTINGS_FILE)
    if (!((await s.get<boolean>('memory_use_server')) ?? true)) return null
  } catch {
    /* ignore */
  }
  const cfg = await getApiConfig()
  return cfg.deviceKey ? { baseUrl: cfg.baseUrl, deviceKey: cfg.deviceKey } : null
}

export async function askContext(opts: {
  projectId: string
  query: string
  taskType?: string
  featureKey?: string
  maxTokens?: number
}): Promise<ContextPackage | null> {
  const srv = await serverTarget()
  if (!srv) return null

  const res = await fetch(`${srv.baseUrl}/api/v1/context/ask`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${srv.deviceKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: opts.query,
      project_id: opts.projectId,
      task_type: opts.taskType ?? inferTaskType(opts.query),
      feature_key: opts.featureKey,
      budget: { max_input_tokens: opts.maxTokens ?? 800 },
    }),
  })
  if (!res.ok) throw new Error(`context/ask HTTP ${res.status}`)
  return (await res.json()) as ContextPackage
}

/**
 * Compact system note to inject. Prefers the server Context Controller
 * (ranked + budgeted), falls back to local memory recall.
 */
export async function buildPromptContextDetails(
  projectId: string,
  query: string,
  limit = 5,
  taskType = inferTaskType(query)
): Promise<PromptContextDetails> {
  try {
    const pkg = await askContext({ projectId, query, taskType, maxTokens: 800 })
    if (pkg) {
      const codeLines = (pkg.code ?? []).map(c => `- Code: ${c.path} (${c.reason}, ${c.score})`)
      const memoryLines = pkg.memory.map(m => `- Memory: ${m.content}`)
      const lines = [...codeLines, ...memoryLines].join('\n')
      const instr = pkg.instructions?.length ? `\n(${pkg.instructions.join(' ')})` : ''
      return {
        text: lines ? `Relevanter Kontext:\n${lines}${instr}` : '',
        contextId: pkg.context_id,
        repoId: pkg.repo_id,
        branch: pkg.branch,
        commitSha: pkg.commit_sha,
        taskType: pkg.task_type,
      }
    }
  } catch (e) {
    console.warn('[context] server ask failed, using local:', e)
  }
  return {
    text: await luczorMemory.getContextForPrompt(projectId, query, limit),
    taskType,
  }
}

export async function buildPromptContext(projectId: string, query: string, limit = 5): Promise<string> {
  return (await buildPromptContextDetails(projectId, query, limit)).text
}
