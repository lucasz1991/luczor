import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_STATE } from '@/state/defaults'
import { mutations, state } from '@/state/store'

describe('transactional local project creation', () => {
  beforeEach(() => {
    mutations.hydrate(structuredClone(DEFAULT_STATE))
    mutations.ensureDefaults()
  })

  it('rolls back every local record created for an uncommitted project', () => {
    mutations.addProject({ id: 'project-new', name: 'Neu' }, false)
    state.todos.push({ id: 'todo-new', projectId: 'project-new' })
    state.todoSteps.push({ id: 'step-new', projectId: 'project-new' })
    state.projectMemories.push({ id: 'memory-new', projectId: 'project-new' })
    state.summaries.push({ id: 'summary-new', projectId: 'project-new', text: 'Neu', createdAt: 1 })

    mutations.rollbackProjectCreation('project-new')

    expect(state.projects.some(project => project.id === 'project-new')).toBe(false)
    expect(state.messages.some(message => message.projectId === 'project-new')).toBe(false)
    expect(state.todos.some(item => item.projectId === 'project-new')).toBe(false)
    expect(state.todoSteps.some(item => item.projectId === 'project-new')).toBe(false)
    expect(state.projectMemories.some(item => item.projectId === 'project-new')).toBe(false)
    expect(state.summaries.some(item => item.projectId === 'project-new')).toBe(false)
    expect(state.pending.toolCallsByProject['project-new']).toBeUndefined()
  })

  it('refuses to roll back the active project', () => {
    mutations.addProject({ id: 'project-active', name: 'Aktiv' })

    expect(() => mutations.rollbackProjectCreation('project-active')).toThrow('aktive Projekt')
    expect(state.projects.some(project => project.id === 'project-active')).toBe(true)
  })
})
