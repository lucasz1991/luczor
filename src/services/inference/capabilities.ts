export const INFERENCE_CAPABILITIES = ['chat', 'reasoning', 'planning', 'execution_preparation'] as const

export type InferenceCapability = (typeof INFERENCE_CAPABILITIES)[number]

export type AgentInferenceRole = 'planner' | 'implementer' | 'reviewer' | 'join' | 'assistant'

export const AGENT_ROLE_TASK_TYPES: Readonly<Record<AgentInferenceRole, string>> = Object.freeze({
  planner: 'planning.agent',
  implementer: 'coding.agent',
  reviewer: 'verification.agent',
  join: 'reasoning.synthesis',
  assistant: 'chat.agent',
})

/** One explicit role contract shared by agent adapters and inference routing. */
export function taskTypeForAgentRole(role: AgentInferenceRole): string {
  switch (role) {
    case 'planner':
      return AGENT_ROLE_TASK_TYPES.planner
    case 'implementer':
      return AGENT_ROLE_TASK_TYPES.implementer
    case 'reviewer':
      return AGENT_ROLE_TASK_TYPES.reviewer
    case 'join':
      return AGENT_ROLE_TASK_TYPES.join
    case 'assistant':
      return AGENT_ROLE_TASK_TYPES.assistant
  }
}

/**
 * Maps the supported task namespace to the signed local-model capability set.
 * Unknown namespaces stay on the least-privileged chat capability.
 */
export function requiredCapabilityForTask(taskType?: string): InferenceCapability {
  const normalized = String(taskType ?? 'chat.general')
    .trim()
    .toLocaleLowerCase('en-US')
  if (normalized === 'coding.review' || normalized.startsWith('verification.') || normalized.startsWith('verifier.')) {
    return 'reasoning'
  }

  const namespace = normalized.split('.', 1)[0]
  switch (namespace) {
    case 'planning':
      return 'planning'
    case 'reasoning':
    case 'analysis':
    case 'verification':
    case 'verifier':
      return 'reasoning'
    case 'coding':
    case 'browser':
    case 'admin':
    case 'execution':
    case 'action':
    case 'tool':
      return 'execution_preparation'
    case 'chat':
    default:
      return 'chat'
  }
}
