import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  detectAgents: vi.fn(),
  runAgentCli: vi.fn(),
  writeBridgeFile: vi.fn(),
  buildBridgeMarkdown: vi.fn(),
  requireProjectWorkspace: vi.fn(),
  getRepositoryExternalPolicy: vi.fn(),
  state: {
    projects: [
      {
        id: 'project-1',
        name: 'Luczor',
        summary: 'Lokaler Agent',
        goals: [{ title: 'Sicher binden', description: '', status: 'in_progress' }],
      },
    ],
  },
}))

vi.mock('@/services/agents', () => ({
  detectAgents: mocks.detectAgents,
  runAgentCli: mocks.runAgentCli,
  writeBridgeFile: mocks.writeBridgeFile,
  buildBridgeMarkdown: mocks.buildBridgeMarkdown,
}))
vi.mock('@/services/projectWorkspace', () => ({
  requireProjectWorkspace: mocks.requireProjectWorkspace,
}))
vi.mock('@/services/repositoryGraph', () => ({
  getRepositoryExternalPolicy: mocks.getRepositoryExternalPolicy,
}))
vi.mock('@/state/store', () => ({ state: mocks.state }))

import { agentTools } from '@/services/tools/agents'

const CONTEXT = { projectId: 'project-1' }

function tool(name: string) {
  const definition = agentTools.find(candidate => candidate.name === name)
  if (!definition) throw new Error(`missing tool ${name}`)
  return definition
}

describe('workspace-bound coding-agent tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireProjectWorkspace.mockResolvedValue({
      rootPath: 'E:\\private\\luczor',
      displayName: 'luczor',
      isGitRepository: true,
      status: 'ready',
    })
    mocks.runAgentCli.mockResolvedValue({ ok: true, code: 0, stdout: 'done', stderr: '' })
    mocks.getRepositoryExternalPolicy.mockResolvedValue('allow_selected')
    mocks.writeBridgeFile.mockResolvedValue('E:\\private\\luczor\\LUCZOR.md')
    mocks.buildBridgeMarkdown.mockReturnValue('# generated bridge')
  })

  it('removes model-provided directory arguments from both schemas', () => {
    for (const name of ['agent_dispatch', 'agent_bridge_write']) {
      const definition = tool(name)
      expect(JSON.stringify(definition.parameters)).not.toMatch(/project_dir|root_path|absolute/iu)
      expect(definition).toMatchObject({
        mutating: true,
        requiresApproval: true,
        dataHandling: 'ephemeral',
        risk: 'critical',
        scope: 'project',
      })
    }
    expect(tool('agent_dispatch').effects).toEqual(['execute'])
    expect(tool('agent_bridge_write').effects).toEqual(['write'])
  })

  it('runs the coding agent only in the active project binding', async () => {
    const result = await tool('agent_dispatch').execute({ agent: 'codex', prompt: '  Prüfen  ' }, CONTEXT)

    expect(mocks.requireProjectWorkspace).toHaveBeenCalledWith('project-1')
    expect(mocks.runAgentCli).toHaveBeenCalledWith('codex', 'Prüfen', 'E:\\private\\luczor')
    expect(result).toEqual({ ok: true, code: 0, stdout: 'done', stderr: '' })
  })

  it('writes the bridge into the binding and returns only a relative path', async () => {
    const result = await tool('agent_bridge_write').execute({ content: '# Explicit' }, CONTEXT)

    expect(mocks.writeBridgeFile).toHaveBeenCalledWith('E:\\private\\luczor', '# Explicit')
    expect(result).toEqual({ ok: true, path: 'LUCZOR.md', workspace: 'luczor' })
    expect(JSON.stringify(result)).not.toContain('E:\\private\\luczor')
  })

  it('cannot bypass a deny policy through an external coding-agent CLI', async () => {
    mocks.getRepositoryExternalPolicy.mockResolvedValue('deny')

    await expect(tool('agent_dispatch').execute({ agent: 'codex', prompt: 'Prüfen' }, CONTEXT)).rejects.toThrow(
      'Repository-Richtlinie'
    )
    expect(mocks.runAgentCli).not.toHaveBeenCalled()
  })

  it('builds the default bridge from the current local project state', async () => {
    await tool('agent_bridge_write').execute({}, CONTEXT)

    expect(mocks.buildBridgeMarkdown).toHaveBeenCalledWith({
      name: 'Luczor',
      summary: 'Lokaler Agent',
      goals: [{ title: 'Sicher binden', description: '', status: 'in_progress' }],
    })
    expect(mocks.writeBridgeFile).toHaveBeenCalledWith('E:\\private\\luczor', '# generated bridge')
  })
})
