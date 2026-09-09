import type { WorkflowArtifactScope, WorkflowNativeInvoke } from './browser'
import type { ExecutionTicket } from '@/services/executionGate'
import { runWorkflowVision, type WorkflowVisionInput } from './vision'

export type WorkflowImageInput = WorkflowVisionInput &
  Readonly<{
    action: 'capabilities' | 'capture' | 'ocr' | 'compare' | 'vision'
    artifactId?: string
    otherArtifactId?: string
    language?: string
    monitorId?: number
    maxChars?: number
  }>

export async function runWorkflowImage(
  input: WorkflowImageInput,
  context: {
    scope: WorkflowArtifactScope
    invokeTask: WorkflowNativeInvoke
    ticket?: ExecutionTicket
    workflowExecutionId?: string
  }
): Promise<Record<string, unknown>> {
  if (input.action === 'vision') {
    if (input.inference !== 'external') throw new Error('workflow_vision_multimodal_runtime_unavailable')
    if (!context.ticket || !context.workflowExecutionId) throw new Error('workflow_execution_identity_required')
    return runWorkflowVision(input, {
      ...context,
      ticket: context.ticket,
      workflowExecutionId: context.workflowExecutionId,
    })
  }
  const { action, artifactId, otherArtifactId, language, monitorId, maxChars } = input
  const options = Object.fromEntries(
    Object.entries({ action, artifactId, otherArtifactId, language, monitorId, maxChars }).filter(
      ([, value]) => value !== undefined
    )
  )
  return context.invokeTask<Record<string, unknown>>('wf_image_action', { ...options, scope: context.scope }, false)
}
