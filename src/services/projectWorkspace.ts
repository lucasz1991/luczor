import { invoke } from '@tauri-apps/api/core'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'

const DEVICE_PRINCIPAL_PURPOSE = 'luczor-project-workspace-principal-v1'
const DEVICE_LOCAL_PRINCIPAL = 'device-local'

export type ProjectWorkspaceStatus = 'ready' | 'missing' | 'inaccessible'

export type ProjectWorkspaceBinding = {
  principalId: string
  projectId: string
  rootPath: string
  displayName: string
  isGitRepository: boolean
  gitRootPath?: string
  status: ProjectWorkspaceStatus
  createdAt?: number
  updatedAt?: number
}

type NativeWorkspaceBinding = Partial<{
  principal_id: string
  principalId: string
  project_id: string
  projectId: string
  root_path: string
  rootPath: string
  display_name: string
  displayName: string
  is_git_repository: boolean
  isGitRepository: boolean
  git_root_path: string | null
  gitRootPath: string | null
  status: string
  created_at: number
  createdAt: number
  updated_at: number
  updatedAt: number
}>

let devicePrincipalPromise: Promise<string> | null = null

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function stableDevicePrincipal(): Promise<string> {
  devicePrincipalPromise ??= (async () => {
    try {
      const seed = await invoke<string>('memory_key_get_or_create')
      if (!/^[a-f0-9]{64}$/iu.test(seed) || !globalThis.crypto?.subtle) return DEVICE_LOCAL_PRINCIPAL
      const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${DEVICE_PRINCIPAL_PURPOSE}\u0000${seed.toLowerCase()}`)
      )
      return `device:v1:${bytesToHex(new Uint8Array(digest))}`
    } catch {
      // The literal fallback is intentionally stable and matches the local
      // memory principal used when no native keychain is available.
      return DEVICE_LOCAL_PRINCIPAL
    }
  })()
  return devicePrincipalPromise
}

/**
 * Use the verified server-account identity when one exists. A project folder
 * never depends on network availability or a Device Key, so an OS-key-backed
 * device identity is the stable local fallback.
 */
export async function resolveWorkspacePrincipalId(): Promise<string> {
  try {
    const account = await getVerifiedAccountSnapshot()
    if (account) return account.principalId
  } catch {
    // Invalid or unavailable remote credentials must never unlock another
    // account's local workspace mapping. Continue in the isolated device scope.
  }
  return stableDevicePrincipal()
}

function normalizeBinding(value: NativeWorkspaceBinding): ProjectWorkspaceBinding {
  const principalId = value.principalId ?? value.principal_id
  const projectId = value.projectId ?? value.project_id
  const rootPath = value.rootPath ?? value.root_path
  const displayName = value.displayName ?? value.display_name
  const isGitRepository = value.isGitRepository ?? value.is_git_repository
  const gitRootPath = value.gitRootPath ?? value.git_root_path ?? undefined
  const status = value.status

  if (!principalId || !projectId || !rootPath || !displayName || typeof isGitRepository !== 'boolean') {
    throw new Error('Die lokale Projektzuordnung ist unvollständig.')
  }
  if (status !== 'ready' && status !== 'missing' && status !== 'inaccessible') {
    throw new Error('Die lokale Projektzuordnung hat einen unbekannten Status.')
  }

  return {
    principalId,
    projectId,
    rootPath,
    displayName,
    isGitRepository,
    gitRootPath,
    status,
    createdAt: value.createdAt ?? value.created_at,
    updatedAt: value.updatedAt ?? value.updated_at,
  }
}

export async function selectProjectWorkspaceDirectory(title = 'Projektordner auswählen'): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false, title })
  return typeof selected === 'string' && selected.trim() ? selected : null
}

export async function bindProjectWorkspace(
  projectId: string,
  rootPath: string,
  principalId?: string
): Promise<ProjectWorkspaceBinding> {
  const principal = principalId ?? (await resolveWorkspacePrincipalId())
  const binding = await invoke<NativeWorkspaceBinding>('project_workspace_bind', {
    payload: { principalId: principal, projectId, rootPath },
  })
  return normalizeBinding(binding)
}

export async function selectAndBindProjectWorkspace(
  projectId: string,
  options: { title?: string; principalId?: string } = {}
): Promise<ProjectWorkspaceBinding | null> {
  const selected = await selectProjectWorkspaceDirectory(options.title)
  if (!selected) return null
  return bindProjectWorkspace(projectId, selected, options.principalId)
}

export async function getProjectWorkspace(
  projectId: string,
  principalId?: string
): Promise<ProjectWorkspaceBinding | null> {
  const principal = principalId ?? (await resolveWorkspacePrincipalId())
  const binding = await invoke<NativeWorkspaceBinding | null>('project_workspace_get', {
    payload: { principalId: principal, projectId },
  })
  return binding ? normalizeBinding(binding) : null
}

export async function requireProjectWorkspace(
  projectId: string,
  principalId?: string
): Promise<ProjectWorkspaceBinding> {
  const binding = await getProjectWorkspace(projectId, principalId)
  if (!binding) {
    throw new Error('Dem aktiven Projekt ist noch kein lokaler Ordner zugeordnet.')
  }
  if (binding.status !== 'ready') {
    throw new Error(`Der lokale Projektordner ist derzeit nicht verfügbar (${binding.status}).`)
  }
  return binding
}

export async function unbindProjectWorkspace(projectId: string, principalId?: string): Promise<void> {
  const principal = principalId ?? (await resolveWorkspacePrincipalId())
  await invoke('project_workspace_unbind', { payload: { principalId: principal, projectId } })
}

/** Test-only reset for deterministic unit coverage. */
export function resetWorkspacePrincipalCacheForTests(): void {
  if (import.meta.env.MODE === 'test') devicePrincipalPromise = null
}
