import { describe, expect, it } from 'vitest'

import { requiredCapabilityForTask, taskTypeForAgentRole } from '@/services/inference/capabilities'

describe('inference capability taxonomy', () => {
  it.each([
    ['planner', 'planning.agent', 'planning'],
    ['implementer', 'coding.agent', 'execution_preparation'],
    ['reviewer', 'verification.agent', 'reasoning'],
    ['join', 'reasoning.synthesis', 'reasoning'],
    ['assistant', 'chat.agent', 'chat'],
  ] as const)('maps %s through an explicit task type and capability', (role, taskType, capability) => {
    expect(taskTypeForAgentRole(role)).toBe(taskType)
    expect(requiredCapabilityForTask(taskType)).toBe(capability)
  })

  it('maps review, browser automation and unknown namespaces deterministically', () => {
    expect(requiredCapabilityForTask('coding.review')).toBe('reasoning')
    expect(requiredCapabilityForTask('browser.automation')).toBe('execution_preparation')
    expect(requiredCapabilityForTask('unexpected.task')).toBe('chat')
  })
})
