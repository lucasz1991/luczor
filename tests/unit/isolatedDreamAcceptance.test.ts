import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDreamAcceptance,
  DREAM_SYNTHETIC_CORPUS,
  dreamSourceRevision,
  newDreamAcceptanceState,
  runDreamAcceptance,
  type DreamAcceptanceGenerate,
  type DreamAcceptanceStore,
} from '../isolated/dreamAcceptance'
import { createDreamFileStore } from '../isolated/dreamFileStore'

const runId = 'isolated-dream-unit'
const proposal = JSON.stringify({
  operations: [
    {
      operation: 'merge',
      targets: ['synthetic-fact', 'synthetic-duplicate'],
      sources: ['synthetic-fact', 'synthetic-duplicate'],
      content: DREAM_SYNTHETIC_CORPUS[0]!.content,
      reason: 'Identische synthetische Quellen.',
    },
    {
      operation: 'conflict',
      targets: [],
      sources: ['synthetic-conflict-a', 'synthetic-conflict-b'],
      content: 'Unbestätigte Beobachtungen widersprechen sich: blau oder grün. Entscheidung bleibt offen.',
      reason: 'Keine belegte Vorrangregel.',
    },
  ],
})
const verification = JSON.stringify({
  approved: true,
  checkedSources: DREAM_SYNTHETIC_CORPUS.map(source => source.id),
  unsupportedFacts: false,
  lostFacts: false,
  lostConstraints: false,
  temporalConflict: false,
})
const generateValid: DreamAcceptanceGenerate = async request => ({
  content: request.stage === 'proposal' ? proposal : verification,
  finishReason: 'stop',
})
const cleanup: Array<() => Promise<void>> = []
function setup(generate: DreamAcceptanceGenerate = generateValid) {
  const state = newDreamAcceptanceState(runId)
  const store: DreamAcceptanceStore = {
    read: async () => structuredClone(state),
    async commit(receipt, signal) {
      signal.throwIfAborted()
      if ((await dreamSourceRevision(state.sources)) !== receipt.revision) throw new Error('stale_source')
      if (!state.receipts.some(item => item.id === receipt.id)) state.receipts.push(structuredClone(receipt))
    },
  }
  const generateSpy = vi.fn(generate)
  const harness = createDreamAcceptance({ runId, store, generate: generateSpy, timing: { idleDelayMs: 100 } })
  cleanup.push(harness.stop)
  return { harness, state, store, generate: generateSpy }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  vi.useRealTimers()
})

describe('isolated synthetic dreaming acceptance', () => {
  it('explains operation target cardinalities for the proposal without supplying corpus-specific answers', async () => {
    const test = setup()
    test.harness.start()
    await vi.advanceTimersByTimeAsync(2)
    await vi.waitFor(() => expect(test.generate).toHaveBeenCalledTimes(2))
    const proposalSystem = test.generate.mock.calls[0]![0].messages[0]!.content
    expect(proposalSystem).toContain('rewrite: targets enthält genau eine')
    expect(proposalSystem).toContain('merge: targets enthält mindestens zwei')
    expect(proposalSystem).toContain('add, conflict und noop: targets ist immer []')
    expect(proposalSystem).toContain('Alle targets müssen auch in sources stehen')
    expect(proposalSystem).toContain('Eine Ziel-ID darf nicht in mehreren Operationen stehen')
    expect(proposalSystem).not.toContain('synthetic-fact')
    expect(proposalSystem).not.toContain('blau')
    expect(test.generate.mock.calls[1]![0].messages[0]!.content).not.toContain('rewrite: targets')
  })

  it.each(['noop-only', 'conflict-dropped', 'conflict-decided'] as const)(
    'does not mark the known corpus as passed for %s even when the model verifier approves',
    async variant => {
      const changes = JSON.parse(proposal)
      if (variant === 'noop-only')
        changes.operations = [{ operation: 'noop', targets: [], sources: [], content: '', reason: 'Nothing to do.' }]
      if (variant === 'conflict-dropped') changes.operations = [changes.operations[0]]
      if (variant === 'conflict-decided') changes.operations[1].content = 'Die Farbe ist grün. Blau war falsch.'
      const test = setup(async request => ({
        content: request.stage === 'proposal' ? JSON.stringify(changes) : verification,
        finishReason: 'stop',
      }))
      test.harness.start()
      await vi.advanceTimersByTimeAsync(2)
      await vi.waitFor(() => expect(test.harness.events.some(event => event.stage === 'settled')).toBe(true))
      expect(await test.harness.report()).toMatchObject({
        status: 'FAIL',
        error: 'synthetic_fixture_expectation_failed',
      })
      expect(test.state.receipts).toHaveLength(0)
    }
  )

  it.each(['manual', 'idle'] as const)('runs the real optimizer and maintenance validators in %s mode', async mode => {
    const test = setup()
    test.harness.start(mode)
    await vi.advanceTimersByTimeAsync(mode === 'manual' ? 2 : 99)
    if (mode === 'idle') {
      await vi.advanceTimersByTimeAsync(2)
    }
    await vi.waitFor(() => expect(test.harness.events.some(event => event.stage === 'settled')).toBe(true))
    const report = await test.harness.report()
    expect(report.status).toBe('PASS')
    expect(test.generate).toHaveBeenCalledTimes(2)
    expect(test.generate.mock.calls[0]![0]).toMatchObject({ runId, stage: 'proposal', maxTokens: 768 })
    expect(report.events).toContainEqual(expect.objectContaining({ stage: mode, outcome: 'started' }))
    expect(report.receipts[0]?.changes.operations.map(operation => operation.operation)).toEqual(['merge', 'conflict'])
    test.harness.optimizer.requestNow()
    await vi.advanceTimersByTimeAsync(2)
    expect(test.generate).toHaveBeenCalledTimes(2)
    expect(test.state.receipts).toHaveLength(1)
  })

  it('waits for idle grace before touching the model', async () => {
    const test = setup()
    test.harness.start('idle')
    await vi.advanceTimersByTimeAsync(99)
    expect(test.generate).not.toHaveBeenCalled()
    expect(test.state.receipts).toHaveLength(0)
  })

  it('yields to a foreground request, drains actual generation and resumes without duplicate writes', async () => {
    let release!: (value: Awaited<ReturnType<DreamAcceptanceGenerate>>) => void
    const pending = new Promise<Awaited<ReturnType<DreamAcceptanceGenerate>>>(resolve => {
      release = resolve
    })
    const test = setup()
    test.generate.mockImplementationOnce(() => pending)
    test.harness.start()
    await vi.advanceTimersByTimeAsync(2)
    await vi.waitFor(() => expect(test.generate).toHaveBeenCalledOnce())
    let admitted = false
    const foreground = test.harness.optimizer.acquireForeground().then(lease => {
      admitted = true
      return lease
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(admitted).toBe(false)
    expect(test.generate.mock.calls[0]![0].signal.aborted).toBe(true)
    release({ content: proposal, finishReason: 'stop' })
    const lease = await foreground
    expect(test.state.receipts).toHaveLength(0)
    lease.release()
    test.harness.optimizer.requestNow()
    await vi.advanceTimersByTimeAsync(2)
    await vi.waitFor(() => expect(test.state.receipts).toHaveLength(1))
    expect(test.state.receipts).toHaveLength(1)
    expect((await test.harness.report()).events).toContainEqual(
      expect.objectContaining({ stage: 'settled', outcome: 'interrupted' })
    )
  })

  it('rejects source changes after model verification and retries using the fresh revision', async () => {
    const test = setup()
    test.generate.mockImplementationOnce(generateValid).mockImplementationOnce(async request => {
      test.state.sources[0]!.revision = '2'
      return generateValid(request)
    })
    test.harness.start()
    await vi.advanceTimersByTimeAsync(2)
    await vi.waitFor(() => expect(test.harness.events.some(event => event.stage === 'settled')).toBe(true))
    expect(await test.harness.report()).toMatchObject({ status: 'FAIL', error: 'stale_source' })
    expect(test.state.receipts).toHaveLength(0)
    test.harness.optimizer.requestNow()
    await vi.advanceTimersByTimeAsync(2)
    await vi.waitFor(() => expect(test.state.receipts).toHaveLength(1))
    expect(test.state.receipts).toHaveLength(1)
  })

  it.each(['stream', 'length', 'invalid-json', 'invented-path', 'verification-rejected'] as const)(
    'does not commit %s output',
    async failure => {
      const test = setup(async request => {
        if (failure === 'stream') throw new Error('runtime_stream_failed')
        if (failure === 'length') return { content: proposal, finishReason: 'length' }
        if (failure === 'invalid-json') return { content: '{broken', finishReason: 'stop' }
        if (failure === 'invented-path')
          return { content: proposal.replace('docs/start.md', 'private/invented.md'), finishReason: 'stop' }
        if (request.stage === 'verification')
          return { content: verification.replace('"approved":true', '"approved":false'), finishReason: 'stop' }
        return generateValid(request)
      })
      test.harness.start()
      await vi.advanceTimersByTimeAsync(2)
      await vi.waitFor(() => expect(test.harness.events.some(event => event.stage === 'settled')).toBe(true))
      const report = await test.harness.report()
      expect(report.status).toBe('FAIL')
      expect(report.error).toBeTruthy()
      expect(report.events.some(event => event.stage === 'commit')).toBe(false)
      expect(test.state.receipts).toHaveLength(0)
    }
  )

  it('reports a busy model as waiting without contacting the injected model', async () => {
    const test = setup()
    const waiting = runDreamAcceptance({ runId, store: test.store, generate: test.generate, available: () => false })
    await vi.advanceTimersByTimeAsync(25)
    expect(await waiting).toMatchObject({ status: 'WAITING' })
    expect(test.generate).not.toHaveBeenCalled()
  })

  it('persists and reloads a synthetic receipt without repeating model work after restart', async () => {
    vi.useRealTimers()
    const directory = await mkdtemp(join(tmpdir(), 'luczor-isolated-dream-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const file = join(directory, 'dream.json')
    const store = await createDreamFileStore(file, runId)
    const first = await runDreamAcceptance({ runId, store, generate: generateValid })
    expect(first.status).toBe('PASS')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- File is inside this test's mkdtemp directory.
    expect(JSON.parse(await readFile(file, 'utf8')).receipts).toHaveLength(1)
    const resumed = await createDreamFileStore(file, runId)
    const forbidden = vi.fn(generateValid)
    const harness = createDreamAcceptance({ runId, store: resumed, generate: forbidden })
    cleanup.unshift(harness.stop)
    harness.start()
    await vi.waitFor(() => expect(harness.optimizer.snapshot().reason).toBe('no_context'))
    expect(forbidden).not.toHaveBeenCalled()
    expect((await resumed.read()).receipts).toHaveLength(1)
    await expect(createDreamFileStore(file, 'isolated-other-account')).rejects.toThrow('isolated_profile_required')
  })
})
