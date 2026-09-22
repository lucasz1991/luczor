import { beforeEach, describe, expect, it } from 'vitest'
import { buildTargetContextPackages } from '@/services/inference/contextBroker'
import { createContextUsageObserver } from '@/services/memory/contextUsage'
import {
  activeMemoryLinks,
  memoryLinkNodeId,
  recordMemoryLinks,
  resetModelActivityForTests,
} from '@/services/memory/modelActivity'
import { memoryUsageEvents, resetMemoryUsage } from '@/services/memory/usage'
import type { PromptFragment } from '@/services/prompt/promptContextAssembler'

const scope = {
  principalId: 'owner',
  serverInstance: 'server',
  projectId: 'project',
  sessionId: 'turn',
  taskType: 'chat',
}
const memory = (id: string, overrides: Partial<PromptFragment> = {}): PromptFragment => ({
  id: `query-memory-${id}`,
  source: 'memory',
  trust: 'untrusted_data',
  scope: 'project',
  egress: 'local_only',
  content: `Private evidence ${id}`,
  provenance: { recordId: id },
  ...overrides,
})
async function setup(fragments: PromptFragment[]) {
  const packages = await buildTargetContextPackages({
    scopeKey: scope,
    fragments: fragments.map(fragment => ({
      ...fragment,
      scope,
      sensitivity: 'normal',
      lifecycle: 'active',
      audiences: ['local_model', 'external_provider'],
      contentHash: '',
    })),
  })
  return { packages, observe: createContextUsageObserver(fragments, packages) }
}
const included = () => memoryUsageEvents().find(row => row.origin === 'chat')!.included

describe('actual submitted memory context attribution', () => {
  it('does not overwrite a recent real write with the next request observation', async () => {
    const { packages, observe } = await setup([memory('one')])
    recordMemoryLinks(['one'], 'updated', 'chat')
    observe({ target: 'local_llama_cpp', messages: [{ role: 'system', content: packages.local.text }] })
    expect(activeMemoryLinks()).toMatchObject([{ id: 'one', state: 'updated' }])
    observe({ target: 'local_llama_cpp', messages: [] })
    expect(activeMemoryLinks()).toMatchObject([{ id: 'one', state: 'updated' }])
  })
  beforeEach(() => {
    resetMemoryUsage()
    resetModelActivityForTests()
  })

  it('counts query memories and prepared artifacts at submission, once across rounds, never inferred source records', async () => {
    const { packages, observe } = await setup([
      memory('one'),
      memory('prepared', {
        id: 'prepared:context:project',
        content: 'Prepared orientation',
        provenance: undefined,
      }),
    ])
    const request = {
      target: 'local_llama_cpp' as const,
      messages: [{ role: 'system' as const, content: packages.local.text }],
    }
    expect(included()).toBe(0)
    observe(request)
    expect(included()).toBe(2)
    expect(activeMemoryLinks().map(memoryLinkNodeId)).toEqual(['memory:one', 'artifact:context:project'])
    observe(request)
    expect(included()).toBe(2)
    expect(activeMemoryLinks().every(link => link.state === 'included')).toBe(true)
  })

  it('uses the actual external package and does not draw private data as used by the local model', async () => {
    const { packages, observe } = await setup([memory('private'), memory('shared', { egress: 'allowed' })])
    observe({ target: 'laravel_proxy', messages: [{ role: 'system', content: packages.external.text }] })
    expect(included()).toBe(1)
    expect(activeMemoryLinks()).toEqual([])
    expect(packages.external.text).not.toContain('Private evidence private')
  })

  it('attributes unconfirmed session recollections only when actually submitted to the local model', async () => {
    const { packages, observe } = await setup([
      memory('candidate', { id: 'session-memory-candidate:candidate', source: 'history', scope: 'session' }),
    ])
    observe({ target: 'laravel_proxy', messages: [{ role: 'system', content: packages.external.text }] })
    expect(included()).toBe(0)
    expect(activeMemoryLinks()).toEqual([])
    observe({ target: 'local_llama_cpp', messages: [{ role: 'system', content: packages.local.text }] })
    expect(included()).toBe(1)
    expect(activeMemoryLinks()).toMatchObject([{ id: 'candidate', state: 'included' }])
  })

  it('ignores removed or rewritten fitted records and user text that happens to quote them', async () => {
    const { packages, observe } = await setup([memory('one')])
    observe({
      target: 'local_llama_cpp',
      messages: [
        { role: 'system', content: packages.local.text.replace('Private evidence one', 'summary') },
        { role: 'user', content: packages.local.text },
      ],
    })
    expect(included()).toBe(0)
    expect(activeMemoryLinks()).toMatchObject([{ id: 'one', state: 'omitted' }])
  })

  it('does not downgrade an included memory when another copy was deduplicated', async () => {
    const { packages, observe } = await setup([
      memory('one', { id: 'memory-project-one', priority: 100 }),
      memory('one'),
    ])
    observe({ target: 'local_llama_cpp', messages: [{ role: 'system', content: packages.local.text }] })
    expect(included()).toBe(1)
    expect(activeMemoryLinks()).toMatchObject([{ id: 'one', state: 'included' }])
  })
})
