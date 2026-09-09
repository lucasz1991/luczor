import { validateToolArguments } from '@/services/tools/validateArguments'
import type { WorkflowLlmInput } from './llm'

/** Build task-specific output contracts before inference. Data never becomes executable instructions. */
export function workflowLlmInput(task: string, params: Record<string, unknown>): WorkflowLlmInput {
  const controls = new Set([
    'instruction',
    'input_bindings',
    'output_format',
    'output_schema',
    'inference',
    'timeout_seconds',
    'max_output_chars',
    'title',
    'list',
    'routes',
    'device_id',
    'project_id',
    'file_scope',
    'workspace_root_id',
    'workspace_root_path',
    'thinking_tier',
    'thinking_config',
    'labels',
    'criteria',
    'model',
    'agent_selection',
  ])
  const inputs = Object.fromEntries(Object.entries(params).filter(([key]) => !controls.has(key)))
  const bound =
    params.input_bindings && typeof params.input_bindings === 'object' && !Array.isArray(params.input_bindings)
      ? params.input_bindings
      : {}
  const input = { ...params, input_bindings: { ...bound, ...inputs } } as WorkflowLlmInput
  if (task === 'llm.text') input.output_format = 'text'
  if (['llm.json', 'llm.classify', 'llm.extract', 'llm.evaluate'].includes(task)) input.output_format = 'json'
  if (
    task === 'llm.extract' &&
    (!input.output_schema || typeof input.output_schema !== 'object' || Array.isArray(input.output_schema))
  )
    throw new Error('workflow_llm_extraction_schema_required')
  if (task === 'llm.classify') {
    const labels = strings(params.labels, 'labels')
    input.input_bindings!.classification_labels = labels
    input.output_schema = {
      type: 'object',
      required: ['label'],
      properties: { label: { type: 'string', enum: labels } },
      additionalProperties: false,
    }
  }
  if (task === 'llm.evaluate') {
    const criteria = strings(params.criteria, 'criteria')
    input.input_bindings!.evaluation_criteria = criteria
    input.output_schema = {
      type: 'object',
      required: ['passed', 'checks'],
      properties: {
        passed: { type: 'boolean' },
        checks: {
          type: 'array',
          minItems: criteria.length,
          maxItems: criteria.length,
          items: {
            type: 'object',
            required: ['criterion', 'passed'],
            properties: {
              criterion: { type: 'string', enum: criteria },
              passed: { type: 'boolean' },
              evidence: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    }
  }
  return input
}

function strings(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 100 ||
    value.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000) ||
    new Set(value).size !== value.length
  )
    throw new Error(`workflow_llm_${field}_invalid`)
  return [...value] as string[]
}

export function checkWorkflowLlmResult(task: string, input: WorkflowLlmInput, result: Record<string, unknown>) {
  if (input.output_format === 'json' && input.output_schema) validateToolArguments(input.output_schema, result.data)
  if (task === 'llm.evaluate') {
    const data = result.data as { passed: boolean; checks: Array<{ criterion: string; passed: boolean }> }
    const criteria = input.input_bindings!.evaluation_criteria as string[]
    if (
      data.checks.length !== criteria.length ||
      new Set(data.checks.map(check => check.criterion)).size !== criteria.length ||
      data.passed !== data.checks.every(check => check.passed)
    )
      throw new Error('workflow_llm_evaluation_inconsistent')
  }
  return result
}
