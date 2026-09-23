import {
  buildScopedContextPackage,
  type ContextScopeKey,
  type TargetContextPackages,
} from '@/services/inference/contextBroker'
import { estimateContextTokens } from '@/services/inference/contextBudget'
import type { InferenceTarget, WireMessage } from '@/services/inference/types'
import type { PromptFragment } from '@/services/prompt/promptContextAssembler'

export type ContextTargetPlan = {
  windowTokens: number
  windowKnown: boolean
  contextBudgetTokens: number
  found: number
  selected: number
  omitted: number
  submitted: number | null
  submittedIds: string[]
}
export type ContextPlanDiagnostics = { local: ContextTargetPlan; external: ContextTargetPlan }
export type ContextPlan = TargetContextPackages & { diagnostics: ContextPlanDiagnostics }
export type ContextPlannerInput = {
  scopeKey: ContextScopeKey
  fragments: readonly PromptFragment[]
  query: string
  local?: { windowTokens?: number; history?: readonly WireMessage[] }
  external?: { windowTokens?: number; history?: readonly WireMessage[] }
  /** Includes tool schemas, system rules and output reserve; final gateway fitting remains authoritative. */
  reserveTokens?: number
}

const words = (text: string) => new Set(text.toLocaleLowerCase('de').match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [])
function relevance(fragment: PromptFragment, query: Set<string>): number {
  const contentWords = words(fragment.content)
  let matches = 0
  for (const word of query) if (contentWords.has(word)) matches++
  return query.size ? matches / query.size : 0
}

/** Deduplicate source identity, not prose similarity. Different known revisions remain visible. */
function sourceIdentity(fragment: PromptFragment): string {
  const record = fragment.provenance?.recordId
  return record
    ? JSON.stringify([
        fragment.scope,
        fragment.source === 'history' ? 'memory' : fragment.source,
        record,
        fragment.provenance?.revision ?? null,
      ])
    : `${fragment.source}:${fragment.id}`
}

function targetBudget(input: ContextPlannerInput, target: 'local' | 'external') {
  const settings = target === 'local' ? input.local : input.external
  const supplied = settings?.windowTokens
  const known = typeof supplied === 'number' && Number.isFinite(supplied) && supplied > 0
  const windowTokens = known ? Math.floor(supplied) : 8192
  const history = estimateContextTokens(JSON.stringify(settings?.history ?? []))
  // Older history is archived by the execution engine; never let it crowd out all fresh evidence.
  const reserve = input.reserveTokens ?? Math.min(4096, Math.floor(windowTokens * 0.4))
  const available = Math.max(0, windowTokens - reserve - Math.min(history, Math.floor(windowTokens / 2)))
  const contextBudgetTokens = Math.min(available, Math.floor(windowTokens / 3))
  return { windowTokens, windowKnown: known, contextBudgetTokens }
}

/** One selection path for project context, memories, prepared packets and repository evidence. */
export async function planContext(input: ContextPlannerInput): Promise<ContextPlan> {
  const queryWords = words(input.query)
  const ranked = input.fragments
    .map(fragment => ({
      ...fragment,
      // Task relevance dominates ordinary importance/source ordering; policy stays mandatory in the broker.
      priority: Math.min(99, fragment.priority ?? 0) + Math.round(relevance(fragment, queryWords) * 1000),
    }))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
  const identities = new Map<string, PromptFragment>()
  const duplicates: string[] = []
  const retained: PromptFragment[] = []
  for (const fragment of ranked) {
    const identity = sourceIdentity(fragment)
    const existing = identities.get(identity)
    if (existing) {
      duplicates.push(fragment.id)
      const restrictiveness = { allowed: 0, approval_required: 1, local_only: 2 }
      if (restrictiveness[fragment.egress] > restrictiveness[existing.egress]) existing.egress = fragment.egress
      if (fragment.trust === 'untrusted_data') existing.trust = 'untrusted_data'
    } else {
      identities.set(identity, fragment)
      retained.push(fragment)
    }
  }
  const scoped = retained.map(fragment => ({
    ...fragment,
    scope: input.scopeKey,
    lifecycle: 'active' as const,
    sensitivity: 'normal' as const,
    audiences: ['local_model', 'external_provider'] as ('local_model' | 'external_provider')[],
    contentHash: '',
  }))
  const build = async (target: 'local' | 'external') => {
    const budget = targetBudget(input, target)
    const maxChars = budget.contextBudgetTokens * 3
    const packet = await buildScopedContextPackage({
      scopeKey: input.scopeKey,
      target: target === 'local' ? 'local_llama_cpp' : 'laravel_proxy',
      fragments: scoped,
      budget: { maxChars, maxFragments: retained.length, maxFragmentChars: Math.min(12_000, maxChars) },
    })
    packet.omitted.push(...duplicates.map(id => ({ id, reason: 'duplicate' as const })))
    const diagnostics: ContextTargetPlan = {
      ...budget,
      found: input.fragments.length,
      selected: packet.selected.length,
      omitted: packet.omitted.length,
      submitted: null,
      submittedIds: [],
    }
    return { packet, diagnostics }
  }
  const [local, external] = await Promise.all([build('local'), build('external')])
  return {
    local: local.packet,
    external: external.packet,
    diagnostics: { local: local.diagnostics, external: external.diagnostics },
  }
}

/** Count only whole source records present in the fitted request actually handed to the gateway. */
export function recordSubmittedContext(
  plan: ContextPlan,
  target: InferenceTarget,
  messages: readonly WireMessage[]
): void {
  const packet = target === 'local_llama_cpp' ? plan.local : plan.external
  const diagnostics = target === 'local_llama_cpp' ? plan.diagnostics.local : plan.diagnostics.external
  const system = messages.filter(message => message.role === 'system').map(message => message.content)
  const lines = new Map<string, string>()
  for (const line of packet.text.split('\n')) {
    try {
      const record = JSON.parse(line)
      if (typeof record?.id === 'string') lines.set(record.id, line)
    } catch {
      /* framing */
    }
  }
  diagnostics.submittedIds = packet.selected
    .filter(({ id }) => {
      const line = lines.get(id)
      return !!line && system.some(text => text.includes(line))
    })
    .map(item => item.id)
  diagnostics.submitted = diagnostics.submittedIds.length
}
