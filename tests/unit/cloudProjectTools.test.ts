import { beforeEach, describe, expect, it, vi } from 'vitest'
const harness = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), write: vi.fn(), project: vi.fn() }))
vi.mock('@/services/api/cloudProjects', () => ({
  cloudProjectFiles: harness.list,
  readCloudProjectFile: harness.read,
  saveCloudProjectFile: harness.write,
}))
vi.mock('@/services/tools/shared', () => ({ getProject: harness.project }))
import { cloudProjectTools } from '@/services/tools/cloudProjects'
import { executionGate, updateExecutionControls } from '@/services/executionGate'
import type { ToolContext } from '@/services/tools/types'
const tool = (name: string) => cloudProjectTools.find(item => item.name === name)!
const context = (): ToolContext => ({ projectId: 'project-1', execution: executionGate.capture() })

beforeEach(() => {
  vi.clearAllMocks()
  updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'project-1' })
  harness.project.mockReturnValue({ id: 'project-1', cloud: { principalId: 'a', projectId: 7 } })
  harness.list.mockResolvedValue([{ path: 'readme.md', revision: 2 }])
  harness.read.mockResolvedValue({ path: 'readme.md', revision: 2, content: 'abcdefgh' })
  harness.write.mockResolvedValue({ path: 'readme.md', revision: 3 })
})
describe('scoped cloud file tools', () => {
  it('bounds file reads and reports the next offset and revision', async () => {
    const result = await tool('project_cloud_read_file').execute(
      { path: 'readme.md', offset: 2, max_chars: 3 },
      context()
    )
    expect(result).toMatchObject({ content: 'cde', next_offset: 5, total_chars: 8, revision: 2, untrusted: true })
    expect(harness.read).toHaveBeenCalledWith('project-1', 'readme.md', expect.any(AbortSignal))
  })
  it('requires an opted-in current project and cannot accept a model-supplied project id', async () => {
    harness.project.mockReturnValue({ id: 'project-1' })
    await expect(tool('project_cloud_list_files').execute({}, context())).rejects.toThrow('global')
    await expect(
      tool('project_cloud_list_files').execute({ project_id: 'another-project' }, context())
    ).rejects.toThrow()
    expect(harness.list).not.toHaveBeenCalled()
  })
  it('blocks writes in observe mode and preserves server conflicts without retry', async () => {
    updateExecutionControls({ mode: 'observe', killSwitch: false, scope: 'project-1' })
    const args = { path: 'readme.md', content: 'new text', expected_revision: 2 }
    await expect(tool('project_cloud_write_file').execute(args, context())).rejects.toThrow()
    expect(harness.write).not.toHaveBeenCalled()
    updateExecutionControls({ mode: 'act', killSwitch: false, scope: 'project-1' })
    harness.write.mockRejectedValueOnce(Object.assign(new Error('revision conflict'), { status: 409 }))
    await expect(tool('project_cloud_write_file').execute(args, context())).rejects.toThrow('revision conflict')
    expect(harness.write).toHaveBeenCalledOnce()
    expect(tool('project_cloud_write_file').requiresApproval).toBe(true)
  })
  it('drops a late read result when Not-Aus invalidates the captured execution', async () => {
    harness.read.mockImplementationOnce(async () => {
      updateExecutionControls({ mode: 'act', killSwitch: true, scope: 'project-1' })
      return { path: 'readme.md', revision: 2, content: 'late private text' }
    })
    await expect(tool('project_cloud_read_file').execute({ path: 'readme.md' }, context())).rejects.toThrow()
  })
})
