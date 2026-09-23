import { describe, expect, it, vi } from 'vitest'
import { createResearchController, type ResearchStepContext } from '@/services/research/controller'
import type { ResearchStore, SavedResearch } from '@/services/research/store'

function saved(): SavedResearch {
  return {
    run: {
      id: 'r',
      principalId: 'account',
      projectId: 'project',
      conversationId: 'chat',
      topic: 'Quelle',
      depth: 'deep',
      stage: 'collecting',
      status: 'queued',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      asOf: '2026-09-23',
      outputDir: 'C:/Research/r',
      questions: [],
      sources: [],
      claims: [],
      artifacts: [],
      blockers: [],
    },
    binding: {
      principalId: 'account',
      projectId: 'project',
      chatId: 'chat',
      runId: 'r',
      rootPath: 'C:/Research/r',
      revision: 1,
      workflowScope: {
        principalId: 'account',
        projectId: 'project',
        runId: 'r',
        researchId: 'r',
        expectedRootPath: 'C:/Research/r',
        expectedWorkspaceUpdatedAt: 1,
      },
    },
    prepare: {
      principalId: 'account',
      projectId: 'project',
      chatId: 'chat',
      runId: 'r',
      target: 'central',
      centralRoot: 'C:/Research',
      slug: 'quelle',
      title: 'Quelle',
    },
    queries: ['source'],
  }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(step = vi.fn<(_saved: SavedResearch, context: ResearchStepContext) => Promise<void>>()) {
  const records = new Map<string, SavedResearch>()
  const store: ResearchStore = {
    save: vi.fn(async value => {
      records.set(value.run.id, structuredClone(value))
    }),
    list: vi.fn(async principal =>
      [...records.values()].filter(value => value.run.principalId === principal).map(value => structuredClone(value))
    ),
  }
  const verify = vi.fn(async () => {})
  const afterRun = vi.fn(async () => {})
  const onChange = vi.fn()
  const controller = createResearchController({ store, step, verify, afterRun, onChange, now: () => 20 })
  return { controller, store, records, verify, afterRun, onChange, step }
}

describe('durable research controller', () => {
  it('pauses promptly, drains the active section and rejects its late completion before explicit resume', async () => {
    const entered = deferred(),
      release = deferred()
    let context!: ResearchStepContext
    const current = fixture(
      vi.fn(async (_value, value) => {
        context = value
        entered.resolve()
        await release.promise
        await value.update({ status: 'completed' })
      })
    )
    await current.controller.register(saved())
    const running = current.controller.run('r')
    await entered.promise
    const paused = current.controller.pause('r')
    expect(context.signal.aborted).toBe(true)
    release.resolve()
    await Promise.all([running, paused])
    expect(current.controller.get('r').run.status).toBe('paused')
    expect(current.records.get('r')?.run.status).toBe('paused')
    expect(current.controller.isRunning('chat')).toBe(false)
    current.step.mockImplementation(async (_value, value) => value.update({ status: 'completed' }))
    await current.controller.run('r')
    expect(current.verify).toHaveBeenCalledTimes(2)
    expect(current.controller.get('r').run.status).toBe('completed')
  })

  it('keeps explicit stop terminal despite the interrupted driver catch and late section write', async () => {
    const entered = deferred(),
      release = deferred()
    const current = fixture(
      vi.fn(async (_value, context) => {
        entered.resolve()
        await release.promise
        await context.update({ status: 'completed' })
      })
    )
    await current.controller.register(saved())
    const running = current.controller.run('r')
    await entered.promise
    const stopped = current.controller.stop('r')
    release.resolve()
    await Promise.all([running, stopped])
    expect(current.controller.get('r').run.status).toBe('cancelled')
    await expect(current.controller.run('r')).rejects.toThrow('beendet')
    await current.controller.pause('r')
    await current.controller.fail('r', new Error('late'))
    expect(current.records.get('r')?.run.status).toBe('cancelled')
  })

  it('does not reopen an already completed run through pause, stop, fail or run', async () => {
    const current = fixture()
    const value = saved()
    value.run.status = 'completed'
    await current.controller.register(value)
    await current.controller.pause('r')
    await current.controller.stop('r')
    await current.controller.fail('r', 'late')
    await expect(current.controller.run('r')).rejects.toThrow('beendet')
    expect(current.controller.get('r').run.status).toBe('completed')
    expect(current.step).not.toHaveBeenCalled()
  })

  it('serializes pending registration per conversation and fences completion after account clear', async () => {
    const current = fixture()
    const release = deferred()
    vi.mocked(current.store.save).mockImplementationOnce(async value => {
      await release.promise
      current.records.set(value.run.id, value)
    })
    const registering = current.controller.register(saved())
    const outcome = registering.catch((error: unknown) => error)
    const second = saved()
    second.run.id = 'second'
    await expect(current.controller.register(second)).rejects.toThrow('bereits')
    current.controller.clear()
    release.resolve()
    expect(await outcome).toMatchObject({ message: 'Recherchekonto geändert.' })
    expect(() => current.controller.get('r')).toThrow('nicht verfügbar')
    expect(current.onChange.mock.lastCall?.[0]).toEqual([])
  })

  it('fences a late tool callback and account-specific recovery after clear', async () => {
    const entered = deferred(),
      release = deferred()
    const current = fixture(
      vi.fn(async (_value, context) => {
        entered.resolve()
        await release.promise
        await context.update({ topic: 'late private value' })
      })
    )
    await current.controller.register(saved())
    const running = current.controller.run('r')
    await entered.promise
    current.controller.clear()
    release.resolve()
    await running
    expect(current.records.get('r')?.run.topic).toBe('Quelle')
    expect(current.onChange.mock.lastCall?.[0]).toEqual([])
    expect(current.afterRun).not.toHaveBeenCalled()
    await current.controller.recover('other-account')
    expect(() => current.controller.get('r')).toThrow('nicht verfügbar')
  })

  it('recovers an unfinished stage paused without executing or inheriting authorization', async () => {
    const current = fixture(vi.fn(async (_value, context) => context.update({ status: 'completed' })))
    const value = saved()
    value.run.status = 'running'
    value.run.stage = 'reviewing'
    current.records.set('r', value)
    await current.controller.recover('account')
    expect(current.controller.get('r').run).toMatchObject({ status: 'paused', stage: 'reviewing' })
    expect(current.verify).not.toHaveBeenCalled()
    expect(current.step).not.toHaveBeenCalled()
    await current.controller.run('r')
    expect(current.verify).toHaveBeenCalledOnce()
    expect(current.step.mock.calls[0]?.[0].run.stage).toBe('reviewing')
  })

  it('blocks before execution when saved artifacts fail verification', async () => {
    const current = fixture()
    await current.controller.register(saved())
    current.verify.mockRejectedValueOnce(new Error('artifact changed'))
    await current.controller.run('r')
    expect(current.step).not.toHaveBeenCalled()
    expect(current.controller.get('r').run).toMatchObject({ status: 'blocked', blockers: ['artifact changed'] })
  })

  it('blocks after three sections without observed progress even if narration is rewritten', async () => {
    let calls = 0
    const current = fixture(
      vi.fn(async (_value, context) => {
        calls++
        await context.update({ limitations: [`Reworded progress ${calls}`] })
      })
    )
    await current.controller.register(saved())
    await current.controller.run('r')
    expect(calls).toBe(3)
    expect(current.controller.get('r').run.status).toBe('blocked')
  })

  it('does not treat new source IDs or reworded unsupported claims as new evidence', async () => {
    let calls = 0
    const current = fixture(
      vi.fn(async (_value, context) => {
        calls++
        const sourceId = `copy-${calls}`
        await context.update({
          sources: [
            {
              id: sourceId,
              url: 'https://example.com',
              title: 'Source',
              capturedAt: calls,
              contentHash: 'same-content',
              readReceiptId: `new-${calls}`,
              kind: 'web',
              coverage: 'partial',
              segments: [{ id: 's', text: 'Same evidence.' }],
            },
          ],
          claims: [
            {
              id: `claim-${calls}`,
              text: `New wording ${calls}`,
              questionIds: ['q'],
              evidence: [{ sourceId, segmentId: 's' }],
              review: { supported: false, freshness: 'unknown', explanation: `Still unsupported ${calls}` },
            },
          ],
        })
      })
    )
    await current.controller.register(saved())
    await current.controller.run('r')
    expect(calls).toBe(4)
    expect(current.controller.get('r').run.status).toBe('blocked')
  })

  it('continues beyond previous total-budget proposals while fresh evidence is arriving', async () => {
    let calls = 0
    const current = fixture(
      vi.fn(async (_value, context) => {
        calls++
        await context.update({
          sources: [
            {
              id: 's',
              url: 'https://example.com',
              title: 'Source',
              capturedAt: calls,
              contentHash: `observed-content-${calls}`,
              readReceiptId: `read-${calls}`,
              kind: 'web',
              coverage: 'complete',
              segments: [{ id: 's', text: `Fresh evidence ${calls}` }],
            },
          ],
          ...(calls === 160 ? { status: 'completed' as const } : {}),
        })
      })
    )
    await current.controller.register(saved())
    await current.controller.run('r')
    expect(calls).toBe(160)
    expect(current.controller.get('r').run.status).toBe('completed')
  })

  it('does not renew progress when a failed review cycles back through collection and synthesis', async () => {
    let calls = 0
    const value = saved()
    value.run.questions = [{ id: 'q', text: 'Current version?', requiresFreshness: true }]
    value.run.claims = [
      {
        id: 'c',
        text: 'An old release.',
        questionIds: ['q'],
        evidence: [],
        review: { supported: false, freshness: 'stale', explanation: 'Old source.' },
      },
    ]
    const current = fixture(
      vi.fn(async (_value, context) => {
        calls++
        const claim = context.read().run.claims[0]!
        await context.update({
          stage: calls % 2 ? 'reviewing' : 'collecting',
          claims: [
            {
              ...claim,
              review:
                calls % 2 ? undefined : { supported: false, freshness: 'stale', explanation: `Still old ${calls}` },
            },
          ],
        })
      })
    )
    await current.controller.register(value)
    await current.controller.run('r')
    expect(calls).toBe(3)
    expect(current.controller.get('r').run.status).toBe('blocked')
  })

  it('persists admission failure as blocked while keeping all saved evidence', async () => {
    const current = fixture()
    await current.controller.register(saved())
    await current.controller.fail('r', new Error('inference unavailable'))
    expect(current.records.get('r')?.run).toMatchObject({
      status: 'blocked',
      blockers: ['inference unavailable'],
      topic: 'Quelle',
    })
  })

  it('preserves a blocked failure while draining a concurrently interrupted active section', async () => {
    const entered = deferred(),
      release = deferred()
    const current = fixture(
      vi.fn(async (_value, context) => {
        entered.resolve()
        await release.promise
        context.signal.throwIfAborted()
      })
    )
    await current.controller.register(saved())
    const running = current.controller.run('r')
    await entered.promise
    const failed = current.controller.fail('r', new Error('native session lost'))
    release.resolve()
    await Promise.all([running, failed])
    expect(current.records.get('r')?.run).toMatchObject({ status: 'blocked', blockers: ['native session lost'] })
  })

  it('waits for a pending registration write before recovering that account without starting it', async () => {
    const current = fixture()
    const release = deferred()
    vi.mocked(current.store.save).mockImplementationOnce(async value => {
      await release.promise
      current.records.set(value.run.id, structuredClone(value))
    })
    const registering = current.controller.register(saved()).catch((error: unknown) => error)
    const recovering = current.controller.recover('account')
    expect(current.store.list).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([registering, recovering])
    expect(current.controller.get('r').run.status).toBe('paused')
    expect(current.step).not.toHaveBeenCalled()
  })

  it('fails closed before the first section when the active-state write cannot be saved', async () => {
    const current = fixture()
    await current.controller.register(saved())
    vi.mocked(current.store.save).mockRejectedValue(new Error('disk unavailable'))
    await expect(current.controller.run('r')).rejects.toThrow('disk unavailable')
    expect(current.step).not.toHaveBeenCalled()
    expect(current.controller.isRunning('chat')).toBe(false)
  })
})
