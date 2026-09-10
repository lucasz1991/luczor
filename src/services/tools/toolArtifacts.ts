import { state } from '@/state/store'
import { saveAppStateStrict } from '@/services/persistence'

export type SavedToolArtifact = Readonly<{
  id: string
  projectId: string
  label: string
  sourceSessionIds: readonly string[]
  createdAt: number
  retention: 'project'
}>

/** Persists only an explicit, redacted artifact reference. */
export async function saveToolArtifact(
  projectId: string,
  input: { label?: string; sourceSessionIds?: readonly string[] }
): Promise<SavedToolArtifact> {
  const artifact: SavedToolArtifact = {
    id: crypto.randomUUID(),
    projectId,
    label: input.label?.trim() || 'Tool-Ergebnis',
    sourceSessionIds: [...(input.sourceSessionIds ?? [])].slice(0, 32),
    createdAt: Date.now(),
    retention: 'project',
  }
  state.toolArtifacts ??= []
  state.toolArtifacts.push(artifact)
  await saveAppStateStrict(state)
  return artifact
}

export function listSavedToolArtifacts(projectId?: string): SavedToolArtifact[] {
  return (state.toolArtifacts ?? []).filter(item => !projectId || item.projectId === projectId)
}
