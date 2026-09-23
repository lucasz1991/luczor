import { describe, expect, it } from 'vitest'
import { researchOnlyUncertainty, researchProbeMutationKey } from '@/services/research/probes'
import { mutationKey, type AgentCheckpoint } from '@/services/agents/chatCheckpoint'

function checkpoint(): AgentCheckpoint {
  return {
    projectId: 'project',
    conversationId: 'chat',
    sessionId: 'session',
    generation: 1,
    objective: 'Research',
    messages: [],
    completedMutations: [],
    ephemeralDataUsed: true,
    dataPolicy: 'ephemeral',
  }
}
describe('research-only uncertainty classification', () => {
  it('recognizes only owned verification adapters without retaining ephemeral arguments', () => {
    expect(
      researchOnlyUncertainty({
        ...checkpoint(),
        uncertainMutations: [mutationKey('research_search', { query: 'current' })],
      })
    ).toBe(true)
    expect(
      researchOnlyUncertainty({
        ...checkpoint(),
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'pending',
                type: 'function',
                function: { name: 'research_read_document', arguments: '{"artifact_id":"known"}' },
              },
            ],
          },
        ],
      })
    ).toBe(true)
    expect(researchOnlyUncertainty(checkpoint())).toBe(false)
  })
  it('does not clear mixed terminal/browser writes or malformed legacy uncertainty', () => {
    for (const name of ['project_terminal_run', 'browser_click', 'fs_write', 'research_submit_claims'])
      expect(
        researchOnlyUncertainty({
          ...checkpoint(),
          uncertainMutations: [mutationKey('research_read', { observation_id: 'known' }), mutationKey(name, {})],
        })
      ).toBe(false)
    expect(researchProbeMutationKey('not json')).toBe(false)
    expect(researchProbeMutationKey('["research_search"]')).toBe(false)
    expect(
      researchOnlyUncertainty({
        ...checkpoint(),
        uncertainMutations: [mutationKey('research_search', {})],
        pendingTaskCreateVerifications: [
          { projectId: 'project', title: 'Unknown create', externalId: 'id', state: 'unknown' },
        ],
      })
    ).toBe(false)
  })
  it('can repeat unfinished read-only host evidence and proposals without admitting generic actions', () => {
    const unresolved = (name: string): AgentCheckpoint => ({
      ...checkpoint(),
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'pending', type: 'function', function: { name, arguments: '{}' } }],
        },
      ],
    })
    for (const name of [
      'research_read_evidence',
      'research_submit_plan',
      'research_submit_claims',
      'research_submit_review',
      'research_request_clarification',
    ]) {
      expect(researchOnlyUncertainty(unresolved(name))).toBe(true)
      expect(researchOnlyUncertainty({ ...unresolved(name), uncertainMutations: [mutationKey(name, {})] })).toBe(false)
    }
    for (const name of ['browser_click', 'browser_dom_read', 'project_terminal_run', 'research_arbitrary'])
      expect(researchOnlyUncertainty(unresolved(name))).toBe(false)
  })
})
