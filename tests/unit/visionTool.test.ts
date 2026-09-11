import { expect, it, vi } from 'vitest'
const { invokeTask } = vi.hoisted(() => ({ invokeTask: vi.fn(async () => ({ text: 'OCR' })) }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: async () => ({ principalId: 'test' }) }))
vi.mock('@/services/tools/toolSessionCoordinator', () => ({
  getToolSession: async () => ({ scope: { projectId: 'p' }, invokeTask, meta: { id: 'session' } }),
}))
import { visionTools } from '@/services/tools/vision'

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
