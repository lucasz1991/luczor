/** Synthetic core integration only: never opens production memory or a model endpoint itself. */
import {
  IdleContextOptimizer,
  type IdleContextOptimizerOptions,
  type IdleOptimizationJob,
} from '@/services/agents/idleContextOptimizer'
import {
  assertPreservedReferences,
  maintenanceHash,
  maintenancePrompt,
  MEMORY_OPERATION_CONTRACT,
  parseMaintenanceVerification,
  parseMemoryChangeSet,
  verificationPrompt,
  type MaintenanceSource,
  type MemoryChangeSet,
} from '@/services/memory/maintenance'

export const DREAM_SYNTHETIC_CORPUS: readonly MaintenanceSource[] = [
  {
    id: 'synthetic-fact',
    kind: 'memory',
    revision: '1',
    content: 'Testprojekt Elbe verwendet die Datei docs/start.md. Änderungen benötigen eine Prüfung.',
  },
  {
    id: 'synthetic-duplicate',
    kind: 'memory',
    revision: '1',
    content: 'Testprojekt Elbe verwendet die Datei docs/start.md. Änderungen benötigen eine Prüfung.',
  },
  {
    id: 'synthetic-conflict-a',
    kind: 'memory',
    revision: '1',
    content: 'Unbestätigte Beobachtung: Die Testfarbe ist blau.',
  },
  {
    id: 'synthetic-conflict-b',
    kind: 'memory',
    revision: '1',
    content: 'Unbestätigte Beobachtung: Die Testfarbe ist grün. Es gibt keine Entscheidung, welche Beobachtung gilt.',
  },
]
export type DreamAcceptanceReceipt = { id: string; revision: string; at: number; changes: MemoryChangeSet }
export type DreamAcceptanceState = {
  schema: 'luczor-isolated-dream-v1'
  runId: string
  sources: MaintenanceSource[]
  receipts: DreamAcceptanceReceipt[]
}
export interface DreamAcceptanceStore {
  read(): Promise<DreamAcceptanceState>
  /** Atomically checks the expected source hash and applies one idempotent synthetic receipt. */
  commit(receipt: DreamAcceptanceReceipt, signal: AbortSignal): Promise<void>
}
export type DreamAcceptanceGenerate = (request: {
  runId: string
  stage: 'proposal' | 'verification'
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
  signal: AbortSignal
}) => Promise<{ content: string; finishReason: string; toolCalls?: unknown[] }>
export type DreamAcceptanceEvent = { runId: string; at: number; stage: string; outcome?: string }
export type DreamAcceptanceOptions = {
  runId: string
  store: DreamAcceptanceStore
  generate: DreamAcceptanceGenerate
  /** False means another owner holds model resources. No endpoint is contacted. */
  available?: () => boolean | Promise<boolean>
  timing?: Partial<IdleContextOptimizerOptions>
}

// QA and production share the parser contract; no corpus-specific answer or ID repair.
const SYNTHETIC_PROPOSAL_CONTRACT = ` JSON-Vertrag: ${MEMORY_OPERATION_CONTRACT}`

export const dreamSourceRevision = (sources: MaintenanceSource[]) => maintenanceHash(sources)
export const newDreamAcceptanceState = (runId: string): DreamAcceptanceState => ({
  schema: 'luczor-isolated-dream-v1',
  runId,
  sources: structuredClone([...DREAM_SYNTHETIC_CORPUS]),
  receipts: [],
})

/** Dataset-specific assertions, never production memory policy or permission gates. */
function meetsSyntheticExpectations(changes: MemoryChangeSet): boolean {
  const merge = changes.operations.find(
    operation =>
      operation.operation === 'merge' &&
      operation.targets.length === 2 &&
      operation.targets.includes('synthetic-fact') &&
      operation.targets.includes('synthetic-duplicate')
  )
  const conflict = changes.operations.find(
    operation =>
      operation.operation === 'conflict' &&
      operation.sources.includes('synthetic-conflict-a') &&
      operation.sources.includes('synthetic-conflict-b')
  )
  return (
    !!merge &&
    !!conflict &&
    merge.content.includes('docs/start.md') &&
    /prüf|pruef|review/i.test(merge.content) &&
    /blau|blue/i.test(conflict.content) &&
    /grün|gruen|green/i.test(conflict.content) &&
    /offen|ungeklärt|ungeklaert|unbestätigt|unbestaetigt|unresolved|unconfirmed|undecided|keine Entscheidung|nicht entschieden/i.test(
      conflict.content
    ) &&
    changes.operations.every(
      operation => operation === merge || operation === conflict || operation.operation === 'noop'
    )
  )
}

export function assertDreamAcceptanceState(state: DreamAcceptanceState, runId: string): void {
  if (
    state.schema !== 'luczor-isolated-dream-v1' ||
    state.runId !== runId ||
    !/^(?:isolated-[a-zA-Z0-9-]+|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(runId)
  )
    throw new Error('isolated_profile_required')
  const known = new Set(DREAM_SYNTHETIC_CORPUS.map(source => source.id))
  if (
    state.sources.length !== known.size ||
    new Set(state.sources.map(source => source.id)).size !== known.size ||
    state.sources.some(source => !known.has(source.id) || source.kind !== 'memory')
  )
    throw new Error('synthetic_sources_required')
}

export function createDreamAcceptance(options: DreamAcceptanceOptions) {
  const events: DreamAcceptanceEvent[] = []
  let latestError: string | undefined
  let settledCount = 0
  const inputs = new Map<string, MaintenanceSource[]>()
  const prepared = new Map<string, MemoryChangeSet>()
  const record = (stage: string, outcome?: string) =>
    events.push({ runId: options.runId, at: Date.now(), stage, outcome })
  const snapshot = async () => {
    const state = await options.store.read()
    assertDreamAcceptanceState(state, options.runId)
    return state
  }
  const inference = async (stage: 'proposal' | 'verification', prompt: string, signal: AbortSignal) => {
    record(stage, 'started')
    const result = await options.generate({
      runId: options.runId,
      stage,
      signal,
      maxTokens: 768,
      messages: [
        {
          role: 'system',
          content:
            'Isolierte Funktionsprüfung mit künstlichen Erinnerungen. Keine Werkzeuge, keine externen Daten. Antworte ausschließlich im angeforderten Format.' +
            (stage === 'proposal' ? SYNTHETIC_PROPOSAL_CONTRACT : ''),
        },
        { role: 'user', content: prompt },
      ],
    })
    signal.throwIfAborted()
    if (result.finishReason !== 'stop')
      throw new Error(result.finishReason === 'length' ? 'output_truncated' : 'incomplete_candidate')
    if (!result.content.trim() || result.toolCalls?.length) throw new Error('invalid_candidate')
    record(stage, 'completed')
    return result.content.trim()
  }
  const optimizer = new IdleContextOptimizer(
    {
      async inspect(signal) {
        signal.throwIfAborted()
        const available = (await options.available?.()) ?? true
        return { available, boundary: options.runId, reason: available ? undefined : 'idle_model_busy' }
      },
      async nextJob(boundary) {
        const state = await snapshot()
        const revision = await dreamSourceRevision(state.sources)
        const existing = state.receipts.find(receipt => receipt.revision === revision)
        if (existing) {
          if (!meetsSyntheticExpectations(existing.changes)) {
            latestError = 'synthetic_fixture_expectation_failed'
            throw new Error(latestError)
          }
          return null
        }
        inputs.set(revision, structuredClone(state.sources))
        return {
          key: 'synthetic-memory',
          fingerprint: revision,
          boundary,
          principalId: options.runId,
          scope: 'user',
          task: 'memory',
          prompt: maintenancePrompt('memory', state.sources),
        }
      },
      async runLocal(job, signal) {
        latestError = undefined
        record(job.manual ? 'manual' : 'idle', 'started')
        try {
          const sources = inputs.get(job.fingerprint)!
          const proposal = await inference('proposal', job.prompt, signal)
          const changes = parseMemoryChangeSet(proposal, sources)
          if (!meetsSyntheticExpectations(changes)) throw new Error('synthetic_fixture_expectation_failed')
          for (const operation of changes.operations) {
            const evidence = sources.filter(source => operation.sources.includes(source.id))
            if (operation.operation === 'rewrite' || operation.operation === 'merge')
              assertPreservedReferences(evidence, operation.content)
            else if (operation.operation !== 'noop') assertPreservedReferences(evidence, operation.content, 'summary')
          }
          const verification = await inference('verification', verificationPrompt(sources, proposal), signal)
          parseMaintenanceVerification(verification, sources)
          prepared.set(job.fingerprint, changes)
          return proposal
        } catch (error) {
          latestError = signal.aborted ? 'interrupted' : error instanceof Error ? error.message : 'model_failed'
          throw error
        }
      },
      async commitCandidate(job: IdleOptimizationJob, _content, signal) {
        try {
          signal.throwIfAborted()
          const state = await snapshot()
          if ((await dreamSourceRevision(state.sources)) !== job.fingerprint) throw new Error('stale_source')
          const changes = prepared.get(job.fingerprint)
          if (!changes) throw new Error('verification_required')
          await options.store.commit(
            { id: `${options.runId}:${job.fingerprint}`, revision: job.fingerprint, at: Date.now(), changes },
            signal
          )
          record('commit', 'completed')
        } catch (error) {
          latestError = signal.aborted ? 'interrupted' : error instanceof Error ? error.message : 'commit_failed'
          throw error
        }
      },
      async settled(job, success, interrupted) {
        inputs.delete(job.fingerprint)
        prepared.delete(job.fingerprint)
        record('settled', success ? 'success' : interrupted ? 'interrupted' : (latestError ?? 'failed'))
        settledCount++
      },
    },
    {
      idleDelayMs: 100,
      intervalMs: 60_000,
      monitorMs: 1000,
      timeoutMs: 60_000,
      errorBackoffMs: 60_000,
      ...options.timing,
    }
  )
  return {
    optimizer,
    events,
    start(mode: 'manual' | 'idle' = 'manual') {
      optimizer.start()
      if (mode === 'manual') optimizer.requestNow()
    },
    async report() {
      const state = await snapshot()
      const status = optimizer.snapshot()
      const revision = await dreamSourceRevision(state.sources)
      const accepted = state.receipts.some(
        receipt => receipt.revision === revision && meetsSyntheticExpectations(receipt.changes)
      )
      return {
        runId: options.runId,
        status:
          status.reason === 'idle_model_busy'
            ? ('WAITING' as const)
            : !latestError && accepted
              ? ('PASS' as const)
              : ('FAIL' as const),
        error: latestError,
        state: status,
        events: structuredClone(events),
        receipts: structuredClone(state.receipts),
        settledCount,
      }
    },
    async waitForSettled(timeoutMs = 65_000) {
      const until = Date.now() + timeoutMs
      while (
        !settledCount &&
        !['idle_model_busy', 'no_context', 'failed'].includes(optimizer.snapshot().reason ?? '')
      ) {
        if (Date.now() >= until) throw new Error('acceptance_wait_timeout')
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    },
    stop: () => optimizer.stop(),
  }
}

/** One real or injected pass; always drain its owner before returning. */
export async function runDreamAcceptance(options: DreamAcceptanceOptions) {
  const harness = createDreamAcceptance(options)
  try {
    harness.start()
    await harness.waitForSettled()
    return await harness.report()
  } finally {
    await harness.stop()
  }
}
