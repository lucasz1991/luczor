import { watch } from 'vue'
import type { ProjectWorkspaceBinding } from '@/services/projectWorkspace'

/** Re-reading identical native data must not revoke the active execution ticket. */
export function watchWorkspaceBinding(read: () => ProjectWorkspaceBinding | null, changed: () => void): () => void {
  return watch(
    [
      () => read()?.principalId,
      () => read()?.projectId,
      () => read()?.rootPath,
      () => read()?.gitRootPath,
      () => read()?.status,
      () => read()?.updatedAt,
    ],
    changed,
    { flush: 'sync' }
  )
}

/** Native reads are tied to one project, verified principal, and latest refresh generation. */
export function createWorkspaceRefresh(options: {
  projectId: () => string
  principal: () => Promise<string>
  load: (projectId: string, principalId: string) => Promise<ProjectWorkspaceBinding | null>
  apply: (binding: ProjectWorkspaceBinding | null) => void
  failed: (error: unknown) => void
}) {
  let generation = 0
  let disposed = false
  return {
    invalidate() {
      generation++
    },
    dispose() {
      disposed = true
      generation++
    },
    async refresh(): Promise<void> {
      const revision = ++generation
      const projectId = options.projectId()
      const current = () => !disposed && generation === revision && options.projectId() === projectId
      let principalId: string | undefined
      try {
        principalId = await options.principal()
        if (!current()) return
        const binding = await options.load(projectId, principalId)
        if (!current()) return
        const latestPrincipal = await options.principal()
        if (!current() || latestPrincipal !== principalId) return
        if (binding && (binding.projectId !== projectId || binding.principalId !== principalId))
          throw new Error('Die lokale Projektzuordnung gehört nicht zum aktuellen Projekt und Benutzer.')
        options.apply(binding)
      } catch (error) {
        if (!current()) return
        if (principalId !== undefined) {
          const latestPrincipal = await options.principal().catch(() => undefined)
          if (!current() || latestPrincipal !== principalId) return
        }
        options.failed(error)
      }
    },
  }
}
