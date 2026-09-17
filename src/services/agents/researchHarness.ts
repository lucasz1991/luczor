/** Public handoff format, not private reasoning or a claim of verified research. */
export const RESEARCH_HANDOFF_INSTRUCTIONS =
  'Return concise findings, supporting source references, contradictions, and remaining questions. ' +
  'Distinguish directly observed evidence from inference and prior knowledge. Cite only sources actually read, ' +
  'using supplied context indices or exact observed URLs/file references; never invent citations or access dates. ' +
  'If tools only inspect supplied context, label the result as context analysis, not live web research. ' +
  'Stop when the bounded question is answered or available sources/budget are exhausted; report gaps instead of claiming success. ' +
  'Do not publish private reasoning.'

/** Completion checks concern returned artifacts, not truth or model quality. */
export function assistanceCompletionIssue(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return 'agent_result_missing'
  const value = output as Record<string, unknown>
  if (value.ok === false || ['failed', 'cancelled', 'canceled', 'error'].includes(String(value.status)))
    return 'agent_result_failed'
  if (
    value.incomplete === true ||
    value.interrupted ||
    value.continuation ||
    ['incomplete', 'partial', 'running', 'pending'].includes(String(value.status)) ||
    value.finishReason === 'length'
  )
    return 'agent_result_incomplete'
  if (typeof value.output !== 'string' || !value.output.trim()) return 'agent_result_empty'
  return undefined
}
