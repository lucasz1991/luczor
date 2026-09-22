import type { TargetContextPackages } from '@/services/inference/contextBroker'
import type { InferenceTarget, WireMessage } from '@/services/inference/types'
import type { PromptFragment } from '@/services/prompt/promptContextAssembler'
import { recordMemoryLinks } from './modelActivity'
import { recordMemoryUsageEvent } from './usage'

export type SubmittedContextRequest = { target: InferenceTarget; messages: readonly WireMessage[] }

/** Observes the fitted request handed to the chosen gateway, not a predicted route or answer usage. */
export function createContextUsageObserver(fragments: readonly PromptFragment[], packages: TargetContextPackages) {
  const counted = new Set<string>()
  return ({ target, messages }: SubmittedContextRequest): void => {
    const packet = target === 'local_llama_cpp' ? packages.local : packages.external
    const systemText = messages.filter(message => message.role === 'system').map(message => message.content)
    const records = new Map<string, string>()
    for (const line of packet.text.split('\n')) {
      try {
        const record = JSON.parse(line)
        if (typeof record?.id === 'string') records.set(record.id, line)
      } catch {
        // Framing and explanatory lines are not context records.
      }
    }
    let newlyIncluded = 0
    const graphLinks = new Map<string, { id: string; kind: 'memory' | 'artifact'; included: boolean }>()
    for (const fragment of fragments) {
      const sessionCandidate = fragment.source === 'history' && fragment.id.startsWith('session-memory-candidate:')
      if (fragment.source !== 'memory' && fragment.source !== 'repository' && !sessionCandidate) continue
      const line = records.get(fragment.id)
      const included = !!line && systemText.some(text => text.includes(line))
      const identity = `${target}:${fragment.id}`
      if (included && !counted.has(identity)) {
        counted.add(identity)
        newlyIncluded++
      }
      // The graph's centre represents the local model. Never attribute external
      // requests to it or infer the original memories used by a prepared artifact.
      if (target !== 'local_llama_cpp') continue
      const kind = fragment.id.startsWith('prepared:') ? 'artifact' : 'memory'
      const id = kind === 'artifact' ? fragment.id.slice('prepared:'.length) : fragment.provenance?.recordId
      if (!id) continue
      const key = `${kind}:${id}`
      graphLinks.set(key, { id, kind, included: included || graphLinks.get(key)?.included === true })
    }
    for (const link of graphLinks.values())
      recordMemoryLinks([link.id], link.included ? 'included' : 'omitted', 'chat', link.kind)
    recordMemoryUsageEvent('chat', 'included', newlyIncluded)
  }
}
