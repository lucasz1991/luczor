// src/services/contextController.ts
//
// Client bridge to the server Context Controller (/api/v1/context/ask), which
// ranks + budgets memory into a small context package. Falls back to local
// memory when the server isn't used/reachable.

import { Store } from '@tauri-apps/plugin-store'
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchBoundedResponseWithTimeout,
  getApiConfig,
  type LuczorApiConfigSnapshot,
} from '@/services/api/luczorApi'
import { getVerifiedAccountSnapshot, type VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { luczorMemory } from '@/services/memory/luczorMemory'
import { buildLocalRepositoryContext, type LocalRepositoryContext } from '@/services/repositoryGraph'

const SETTINGS_FILE = 'luczor.settings.json'
const MAX_CONTEXT_RESPONSE_BYTES = 1024 * 1024

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
  repositoryApprovalRequired?: boolean
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

async function serverTarget(
  verifiedConfig?: LuczorApiConfigSnapshot
): Promise<{ baseUrl: string; deviceKey: string } | null> {
  try {
    const s = await Store.load(SETTINGS_FILE)
    if (!((await s.get<boolean>('memory_use_server')) ?? true)) return null
  } catch {
    /* ignore */
  }
  const cfg = verifiedConfig ?? (await getApiConfig())
  return cfg.deviceKey ? { baseUrl: cfg.baseUrl, deviceKey: cfg.deviceKey } : null
}

export async function askContext(opts: {
  projectId: string
  query: string
  taskType?: string
  featureKey?: string
  maxTokens?: number
  maxItems?: number
  localRepository?: LocalRepositoryContext
  account?: VerifiedAccountSnapshot | null
}): Promise<ContextPackage | null> {
  const srv = await serverTarget(opts.account?.config)
  if (!srv) return null

  const { response, text } = await fetchBoundedResponseWithTimeout(
    `${srv.baseUrl}/api/v1/context/ask`,
    {
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
        budget: {
          max_input_tokens: opts.maxTokens ?? 800,
          max_items: Math.max(1, Math.min(20, Math.round(opts.maxItems ?? 6))),
        },
        repo_id: opts.localRepository?.repositoryId,
        branch: opts.localRepository?.branch,
        commit_sha: opts.localRepository?.commitSha,
        code: opts.localRepository?.hints ?? [],
      }),
      redirect: 'error',
    },
    DEFAULT_FETCH_TIMEOUT_MS,
    MAX_CONTEXT_RESPONSE_BYTES
  )
  if (!response.ok) throw new Error(`context/ask HTTP ${response.status}`)
  return JSON.parse(text) as ContextPackage
}

/**
 * Compact system note to inject. Prefers the server Context Controller
 * (ranked + budgeted), falls back to local memory recall.
 */
export async function buildPromptContextDetails(
  projectId: string,
  query: string,
  limit = 5,
  taskType = inferTaskType(query),
  repositoryApprovedForTurn = false
): Promise<PromptContextDetails> {
  const account = await getVerifiedAccountSnapshot()
  const localRepository: LocalRepositoryContext = account
    ? await buildLocalRepositoryContext(
        account.principalId,
        projectId,
        query,
        taskType,
        Math.min(8, limit + 2),
        repositoryApprovedForTurn
      )
    : {
        text: '',
        hints: [],
        policy: 'deny',
        requiresApproval: false,
      }
  try {
    const pkg = await askContext({
      projectId,
      query,
      taskType,
      maxTokens: 800,
      maxItems: limit,
      localRepository,
      account,
    })
    if (pkg) {
      const codeLines = (pkg.code ?? []).map(c => `- Code: ${c.path} (${c.reason}, ${c.score})`)
      // Keep only the explicit provenance allowlist in the provider-facing
      // context. In particular, never interpolate raw meta/source_ref fields.
      const memoryLines = pkg.memory.map(
        m =>
          `- Memory-Kontext (untrusted data): ${JSON.stringify({
            ...(typeof m.id === 'string' && m.id.trim() ? { id: m.id.trim().slice(0, 120) } : {}),
            type: String(m.type ?? 'note').slice(0, 80),
            staleness: String(m.staleness ?? 'unknown').slice(0, 40),
            score: Number.isFinite(Number(m.score)) ? Math.max(0, Math.min(1, Number(m.score))) : 0,
            content: String(m.content ?? ''),
          })}`
      )
      const lines = [...codeLines, ...memoryLines].join('\n')
      const instr = pkg.instructions?.length ? `\n(${pkg.instructions.join(' ')})` : ''
      const serverContext = lines ? `Relevanter Kontext:\n${lines}${instr}` : ''
      return {
        text: [localRepository.text, serverContext].filter(Boolean).join('\n\n'),
        contextId: pkg.context_id,
        repoId: localRepository.repositoryId ?? pkg.repo_id,
        branch: localRepository.branch ?? pkg.branch,
        commitSha: localRepository.commitSha ?? pkg.commit_sha,
        taskType: pkg.task_type,
        repositoryApprovalRequired: localRepository.requiresApproval,
      }
    }
  } catch (e) {
    console.warn('[context] server ask failed, using local:', e)
  }
  return {
    text: [localRepository.text, await luczorMemory.getContextForPrompt(projectId, query, limit)]
      .filter(Boolean)
      .join('\n\n'),
    taskType,
    repositoryApprovalRequired: localRepository.requiresApproval,
  }
}

export async function buildPromptContext(projectId: string, query: string, limit = 5): Promise<string> {
  return (await buildPromptContextDetails(projectId, query, limit)).text
}
