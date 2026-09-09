import type { WorkflowArtifactScope, WorkflowNativeInvoke } from './browser'

export type WorkflowImageInput = Readonly<{
  action: 'capabilities' | 'capture' | 'ocr' | 'compare' | 'vision'
  artifactId?: string
  otherArtifactId?: string
  language?: string
  monitorId?: number
  maxChars?: number
}>

export async function runWorkflowImage(
  input: WorkflowImageInput,
  context: { scope: WorkflowArtifactScope; invokeTask: WorkflowNativeInvoke }
): Promise<Record<string, unknown>> {
  if (input.action === 'vision') {
    // The current inference contract accepts text. A catalog label cannot turn it into image inference.
    throw new Error('workflow_vision_multimodal_runtime_unavailable')
  }
  return context.invokeTask<Record<string, unknown>>('wf_image_action', { ...input, scope: context.scope }, false)
}
