import { ref } from 'vue'
import type { Project } from '@/state/types'
import { state } from '@/state/store'

/** Cloud caches are visible only within the currently verified account. Local-only projects are unchanged. */
export const cloudProjectPrincipal = ref('')
export function canAccessCloudProject(
  project: Pick<Project, 'cloud'>,
  principalId = cloudProjectPrincipal.value
): boolean {
  return !project.cloud || (!!principalId && project.cloud.principalId === principalId)
}

/** Imported projects keep the same server task/chat identity despite a device-local project ID. */
export function projectExternalIdForServer(projectId: string | undefined, principalId = cloudProjectPrincipal.value): string | undefined {
  if (!projectId) return projectId
  const project = state.projects.find(item => item.id === projectId)
  if (project && !canAccessCloudProject(project, principalId)) throw new Error('Das Projekt gehört zu einem anderen Benutzer.')
  return project?.cloud?.externalId ?? projectId
}
