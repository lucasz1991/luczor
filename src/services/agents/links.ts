import { Store } from '@tauri-apps/plugin-store'
import type { AgentProjectLink, AgentProjectSnapshot } from './types'

const FILE = 'luczor.agent-links.json'
const KEY = 'links_v1'
let serial = Promise.resolve()

function sameWorkspace(link: AgentProjectLink, project: AgentProjectSnapshot): boolean {
  return (
    link.principalId === project.principalId &&
    link.projectId === project.projectId &&
    link.workspaceRoot === project.rootPath &&
    link.workspaceUpdatedAt === project.workspaceUpdatedAt
  )
}

function isLink(value: unknown): value is AgentProjectLink {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    [record.principalId, record.projectId, record.adapterId, record.externalThreadId, record.workspaceRoot].every(
      value => typeof value === 'string' && !!value && value.length <= 4096
    ) &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    (record.workspaceUpdatedAt === undefined ||
      (typeof record.workspaceUpdatedAt === 'number' && Number.isFinite(record.workspaceUpdatedAt))) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(String(record.externalThreadId))
  )
}

export async function getAgentProjectLink(project: AgentProjectSnapshot): Promise<AgentProjectLink | undefined> {
  await serial
  const store = await Store.load(FILE)
  const entries = await store.get<unknown>(KEY)
  return Array.isArray(entries)
    ? entries.filter(isLink).find(link => link.adapterId === 'codex' && sameWorkspace(link, project))
    : undefined
}

/** Called only after successful scope validation with an ID returned by the native runtime. */
export function saveAgentProjectLink(
  project: AgentProjectSnapshot,
  externalThreadId: string,
  validateCurrentScope: (project: AgentProjectSnapshot) => Promise<void>
): Promise<void> {
  const snapshot = Object.freeze({ ...project })
  if (!snapshot.rootPath || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(externalThreadId))
    return Promise.reject(new Error('Ungültige Codex-Verknüpfung.'))
  const operation = serial.then(async () => {
    const store = await Store.load(FILE)
    const raw = await store.get<unknown>(KEY)
    const entries: AgentProjectLink[] = Array.isArray(raw) ? raw.filter(isLink) : []
    await validateCurrentScope(snapshot)
    const retained = entries.filter(
      link =>
        !(
          link.principalId === snapshot.principalId &&
          link.projectId === snapshot.projectId &&
          link.adapterId === 'codex'
        )
    )
    retained.push({
      principalId: snapshot.principalId,
      projectId: snapshot.projectId,
      adapterId: 'codex',
      externalThreadId,
      workspaceRoot: snapshot.rootPath!,
      workspaceUpdatedAt: snapshot.workspaceUpdatedAt,
      updatedAt: Date.now(),
    })
    await store.set(KEY, retained.slice(-500))
    await store.save()
  })
  serial = operation.catch(() => undefined)
  return operation
}
