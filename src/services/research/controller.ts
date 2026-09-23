import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import type { ResearchRun, ResearchStatus } from './types'
import { researchRecoveryNeedsReview, type ResearchStore, type SavedResearch } from './store'
import { researchEvidenceFingerprint } from './evidence'

export type ResearchStepContext = {
  signal: AbortSignal
  read(): SavedResearch
  update(patch: Partial<ResearchRun>, extra?: Partial<Pick<SavedResearch, 'queries' | 'checkpoint'>>): Promise<void>
  checkpoint(value: AgentCheckpoint): Promise<void>
}
export type ResearchControllerDependencies = {
  store: ResearchStore
  step(state: SavedResearch, context: ResearchStepContext): Promise<void>
  verify(state: SavedResearch, signal: AbortSignal): Promise<void>
  beforeRun?(state: SavedResearch, signal: AbortSignal): Promise<void>
  afterRun?(state: SavedResearch): Promise<void>
  onChange?(runs: ResearchRun[]): void
  now?: () => number
}
const active = (status: ResearchStatus) => status === 'running' || status === 'queued'
const terminal = (status: ResearchStatus) => status === 'completed' || status === 'cancelled'
const progressFacts = (run: ResearchRun): Set<string> => {
  const facts = new Set(
    run.questions.map(question => JSON.stringify(['question', question.text, question.requiresFreshness]))
  )
  for (const source of run.sources) facts.add(JSON.stringify(['source', source.url, source.contentHash]))
  for (const claim of run.claims) {
    const coverage = [
      claim.questionIds.map(id => run.questions.find(question => question.id === id)?.text ?? id).sort(),
      claim.evidence
        .map(ref => {
          const source = run.sources.find(item => item.id === ref.sourceId)
          const segment = source?.segments.find(item => item.id === ref.segmentId)
          return JSON.stringify([source?.url, source?.contentHash, segment?.text])
        })
        .sort(),
    ]
    facts.add(JSON.stringify(['coverage', coverage]))
    if (claim.review?.supported && ['current', 'not_required'].includes(claim.review.freshness))
      facts.add(JSON.stringify(['supported', coverage, claim.text]))
  }
  if (run.reviewProgress?.inputFingerprint === researchEvidenceFingerprint(run)) {
    const receipts = new Set(run.reviewProgress.readReceiptIds)
    for (const claim of run.claims)
      for (const ref of claim.evidence) {
        if (!receipts.has(`review:${ref.sourceId}:${ref.segmentId}`)) continue
        const source = run.sources.find(item => item.id === ref.sourceId)
        const segment = source?.segments.find(item => item.id === ref.segmentId)
        if (source && segment) facts.add(JSON.stringify(['review-read', source.url, source.contentHash, segment.text]))
      }
  }
  return facts
}

/** Host-owned phases; no overall budget. Stable progress, cancellation and durable boundaries control continuation. */
export function createResearchController(dependencies: ResearchControllerDependencies) {
  const now = dependencies.now ?? Date.now
  const entries = new Map<string, SavedResearch>()
  const drivers = new Map<string, { controller: AbortController; settled: Promise<void> }>()
  const writes = new Map<string, Promise<void>>()
  const registrations = new Map<string, symbol>()
  const registering = new Set<Promise<void>>()
  let epoch = 0
  const notify = () => dependencies.onChange?.([...entries.values()].map(entry => entry.run))
  const get = (id: string) => {
    const entry = entries.get(id)
    if (!entry) throw new Error('Recherche nicht verfügbar.')
    return entry
  }
  async function update(
    id: string,
    patch: Partial<ResearchRun>,
    extra: Partial<SavedResearch> = {},
    signal?: AbortSignal,
    accepts?: (current: SavedResearch) => boolean
  ) {
    const expectedEpoch = epoch
    const pending = (writes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted()
        if (expectedEpoch !== epoch) throw new Error('Recherchekonto geändert.')
        const current = get(id)
        if (accepts && !accepts(current)) return
        const next = {
          ...current,
          ...extra,
          run: {
            ...current.run,
            ...patch,
            id: current.run.id,
            principalId: current.run.principalId,
            projectId: current.run.projectId,
            conversationId: current.run.conversationId,
            revision: current.run.revision + 1,
            updatedAt: now(),
          },
        }
        if (
          Object.hasOwn(extra, 'checkpoint') &&
          extra.checkpoint === undefined &&
          researchRecoveryNeedsReview(current)
        )
          next.recoveryNeedsReview = true
        await dependencies.store.save(next)
        // A stop may arrive during disk I/O. It schedules its own state write behind this one.
        if (expectedEpoch === epoch) {
          entries.set(id, next)
          notify()
        }
      })
    writes.set(id, pending)
    await pending
  }
  async function drive(id: string, externalSignal?: AbortSignal) {
    if (drivers.has(id)) throw new Error('Diese Recherche läuft bereits.')
    if (terminal(get(id).run.status)) throw new Error('Dieser Recherchelauf ist beendet.')
    const controller = new AbortController()
    const generation = epoch
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal
    let resolveSettled!: () => void
    const settled = new Promise<void>(resolve => {
      resolveSettled = resolve
    })
    const driver = { controller, settled }
    drivers.set(id, driver)
    const context: ResearchStepContext = {
      signal,
      read: () => get(id),
      update: (patch, extra) => update(id, patch, extra, signal),
      checkpoint: checkpoint => update(id, {}, { checkpoint }, signal),
    }
    try {
      signal.throwIfAborted()
      await dependencies.beforeRun?.(get(id), signal)
      await dependencies.verify(get(id), signal)
      await context.update({ status: 'running', blockers: [] })
      const seen = progressFacts(get(id).run)
      let stagnant = 0
      while (active(get(id).run.status)) {
        signal.throwIfAborted()
        await dependencies.step(get(id), context)
        signal.throwIfAborted()
        if (!active(get(id).run.status)) break
        const next = progressFacts(get(id).run)
        const fresh = [...next].some(fact => !seen.has(fact))
        stagnant = fresh ? 0 : stagnant + 1
        for (const fact of next) seen.add(fact)
        if (stagnant >= 3) {
          await context.update({
            status: 'blocked',
            blockers: [
              'Drei Arbeitsabschnitte ohne neue Belege oder Fortschritt. Zwischenstand prüfen und gezielt fortsetzen.',
            ],
          })
        }
      }
    } catch (error) {
      if (generation === epoch && entries.has(id) && active(get(id).run.status)) {
        await update(
          id,
          {
            status: signal.aborted ? 'paused' : 'blocked',
            blockers: [
              signal.aborted
                ? 'Recherche unterbrochen. Bereits gespeicherte Belege bleiben erhalten.'
                : error instanceof Error
                  ? error.message
                  : 'Recherche konnte nicht fortgesetzt werden.',
            ],
          },
          {},
          undefined,
          current => active(current.run.status)
        )
      }
    } finally {
      try {
        if (generation === epoch && entries.has(id)) await dependencies.afterRun?.(get(id))
      } finally {
        if (drivers.get(id) === driver) drivers.delete(id)
        resolveSettled()
      }
    }
  }
  return {
    get,
    isRunning: (conversationId: string) =>
      [...entries.values()].some(entry => entry.run.conversationId === conversationId && drivers.has(entry.run.id)),
    async recover(principalId: string) {
      const generation = ++epoch
      for (const driver of drivers.values()) driver.controller.abort()
      entries.clear()
      notify()
      await Promise.allSettled([...writes.values(), ...registering])
      if (generation !== epoch) return
      const loaded = await dependencies.store.list(principalId)
      if (generation !== epoch) return
      for (const entry of loaded) {
        if (active(entry.run.status))
          entry.run = {
            ...entry.run,
            status: 'paused',
            blockers: ['Nach Neustart wiederhergestellt. Mit Fortsetzen Berechtigungen und Dateien erneut prüfen.'],
          }
        entries.set(entry.run.id, entry)
      }
      notify()
    },
    async register(entry: SavedResearch) {
      const generation = epoch
      const keys = [
        JSON.stringify(['run', entry.run.principalId, entry.run.id]),
        JSON.stringify(['chat', entry.run.principalId, entry.run.conversationId]),
      ]
      if (
        keys.some(key => registrations.has(key)) ||
        entries.has(entry.run.id) ||
        [...entries.values()].some(
          existing => existing.run.conversationId === entry.run.conversationId && active(existing.run.status)
        )
      )
        throw new Error('In diesem Chat ist bereits eine Recherche aktiv.')
      const owner = Symbol(entry.run.id)
      for (const key of keys) registrations.set(key, owner)
      const pending = dependencies.store.save(entry)
      registering.add(pending)
      try {
        await pending
        if (generation !== epoch) throw new Error('Recherchekonto geändert.')
        entries.set(entry.run.id, entry)
        notify()
      } finally {
        registering.delete(pending)
        for (const key of keys) if (registrations.get(key) === owner) registrations.delete(key)
      }
    },
    run: drive,
    async amend(id: string, text: string) {
      const value = text.trim()
      if (!value || value.length > 20000) throw new Error('Die Ergänzung benötigt 1 bis 20.000 Zeichen.')
      const current = get(id)
      if (drivers.has(id) || !['paused', 'blocked'].includes(current.run.status))
        throw new Error('Ergänzungen sind nur bei einer pausierten oder blockierten Recherche möglich.')
      await update(
        id,
        {
          clarifications: [...(current.run.clarifications ?? []), value],
          stage: 'planning',
          questions: [],
          claims: [],
          review: undefined,
          reviewProgress: undefined,
          report: undefined,
          blockers: [],
        },
        { queries: [], checkpoint: undefined },
        undefined,
        latest => !drivers.has(id) && ['paused', 'blocked'].includes(latest.run.status)
      )
    },
    async pause(id: string) {
      if (terminal(get(id).run.status)) return
      const driver = drivers.get(id)
      driver?.controller.abort(new DOMException('Recherche pausiert.', 'AbortError'))
      await update(
        id,
        { status: 'paused', blockers: ['Vom Nutzer pausiert.'] },
        {},
        undefined,
        current => !terminal(current.run.status)
      )
      await driver?.settled
    },
    async stop(id: string) {
      if (terminal(get(id).run.status)) return
      const driver = drivers.get(id)
      driver?.controller.abort(new DOMException('Recherche gestoppt.', 'AbortError'))
      await update(
        id,
        { status: 'cancelled', blockers: ['Vom Nutzer gestoppt. Zwischenbericht und Belege bleiben erhalten.'] },
        {},
        undefined,
        current => !terminal(current.run.status)
      )
      await driver?.settled
    },
    async fail(id: string, error: unknown) {
      if (terminal(get(id).run.status)) return
      const driver = drivers.get(id)
      driver?.controller.abort(new DOMException('Recherche fehlgeschlagen.', 'AbortError'))
      await update(
        id,
        { status: 'blocked', blockers: [error instanceof Error ? error.message : String(error)] },
        {},
        undefined,
        current => !terminal(current.run.status)
      )
      await driver?.settled
    },
    clear() {
      epoch++
      for (const driver of drivers.values()) driver.controller.abort()
      entries.clear()
      registrations.clear()
      notify()
    },
  }
}
