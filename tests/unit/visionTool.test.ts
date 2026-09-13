import { beforeEach, expect, it, vi } from 'vitest'
const { invokeTask } = vi.hoisted(() => ({ invokeTask: vi.fn(async () => ({ text: 'OCR' })) }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: async () => ({ principalId: 'test' }) }))
vi.mock('@/services/tools/toolSessionCoordinator', () => ({
  getToolSession: async () => ({ scope: { projectId: 'p' }, invokeTask, meta: { id: 'session' } }),
}))
import { visionTools } from '@/services/tools/vision'

beforeEach(() => invokeTask.mockClear())

it('exposes native capability inspection and avoids unsupported local vision requests', async () => {
  await visionTools[0]!.execute({ action: 'capabilities' }, { projectId: 'p' })
  expect(invokeTask).toHaveBeenCalledWith(
    'wf_image_action',
    { action: 'capabilities', scope: { projectId: 'p' } },
    false
  )
  invokeTask.mockClear()
  await expect(
    visionTools[0]!.execute({ action: 'vision', artifact_id: 'image', instruction: 'Analysieren' }, { projectId: 'p' })
  ).resolves.toMatchObject({
    ok: false,
    code: 'workflow_vision_multimodal_runtime_unavailable',
    next_arguments: { action: 'capabilities' },
  })
  expect(invokeTask).not.toHaveBeenCalled()
})

it('passes the requested OCR output bound through to the native image action', async () => {
  const result = await visionTools[0]!.execute(
    { action: 'ocr', artifact_id: 'image', max_output_chars: 512 },
    { projectId: 'p' }
  )
  expect(result).toEqual({ text: 'OCR' })
  expect(invokeTask).toHaveBeenCalledWith(
    'wf_image_action',
    { action: 'ocr', artifactId: 'image', maxChars: 512, scope: { projectId: 'p' } },
    false
  )
})
