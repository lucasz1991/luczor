import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveAppStateStrict = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/services/persistence', () => ({ saveAppStateStrict }))

import { state } from '@/state/store'
import { listSavedToolArtifacts, saveToolArtifact } from '@/services/tools/toolArtifacts'

describe('Tool-Center artifact retention', () => {
  beforeEach(() => {
    state.toolArtifacts = []
    saveAppStateStrict.mockClear()
  })

  it('keeps results ephemeral until an explicit redacted project save', async () => {
    expect(listSavedToolArtifacts('project-1')).toEqual([])
    const saved = await saveToolArtifact('project-1', { label: 'DOM-Ausgabe', sourceSessionIds: ['run-1'] })

    expect(saved).toMatchObject({ projectId: 'project-1', label: 'DOM-Ausgabe', retention: 'project' })
    expect(saved.sourceSessionIds).toEqual(['run-1'])
    expect(listSavedToolArtifacts('project-1')).toEqual([saved])
    expect(saveAppStateStrict).toHaveBeenCalledOnce()
  })
})
