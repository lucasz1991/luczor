import { describe, expect, it } from 'vitest'
import { createLocalModelDiagnostics, localModelDiagnosticCopy } from '@/services/inference/localModelDiagnostics'
import type { LocalFailureDiagnostic } from '@/services/inference/localFailure'

const failure: LocalFailureDiagnostic = {
  schemaVersion: 1,
  stage: 'generation',
  httpStatus: 400,
  code: 'runtime_tool_contract_rejected',
  parameter: 'tools',
  reason: 'tool_contract',
  inputTokens: 1234,
  contextTokens: 8192,
  outputTokens: 0,
}

const result = {
  content: 'Öffentliche Antwort',
  rawToolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 999 },
}

describe('local model observation boundary', () => {
  it('shares and copies numeric context categories without extra fields or prompt text', () => {
    const budget = {
      estimatedInputTokens: 1200,
      targetTokens: 4000,
      overTarget: false,
      summarizedMessages: 8,
      shortenedToolResults: 1,
      categories: { rules: 200, profile: 100, knowledge: 300, history: 500, tools: 100, secret: 'private-category' },
      prompt: 'private-prompt',
    }
    const source = createLocalModelDiagnostics()
    source.begin('local', [], budget)
    const target = createLocalModelDiagnostics()
    target.acceptNumericSnapshot(source.numericSnapshot())
    const observation = target.state.runs[0]!
    expect(observation.budget?.categories.history).toBe(500)
    expect(localModelDiagnosticCopy(observation)).toContain('Kontextplanung (geschätzt): 1200')
    expect(JSON.stringify(target.state)).not.toContain('private-')
    target.acceptNumericSnapshot([{ ...source.numericSnapshot()[0], budget: { ...budget, targetTokens: NaN } }])
    expect(target.state.runs[0]?.budget).toBeUndefined()
  })
  it('retains only validated failure fields and copies a fixed diagnostic without conversation data', () => {
    const monitor = createLocalModelDiagnostics()
    const run = monitor.begin('Laptop Qwen3-4B', [
      { role: 'system', content: 'hidden-system-instruction' },
      { role: 'user', content: 'private-user-content' },
    ])
    run.delta('<think>private-reasoning</think>Public answer excluded from diagnostic copy')
    const incoming: Record<string, unknown> = {
      ...failure,
      message: 'Raw server body with secret-token',
      endpoint: 'https://private-endpoint.example',
      prompt: 'raw-private-prompt',
    }
    run.fail(false, incoming)
    incoming.parameter = 'mutated-after-delivery'
    const observation = monitor.state.runs[0]!
    expect(observation.failure).toEqual(failure)
    const stored = JSON.stringify(observation)
    const copied = localModelDiagnosticCopy(observation)
    expect(copied).toContain('Modell: Laptop Qwen3-4B')
    expect(copied).toContain('HTTP: 400')
    expect(copied).toContain('Parameter: tools')
    expect(copied).toContain('Eingabetokens (erfasst): 1234')
    expect(copied).toContain('Ausgabelimit (Tokens, erfasst): 0')
    expect(copied).not.toContain('Public answer excluded')
    expect(copied).not.toContain('roles')
    expect(copied).not.toContain('events')
    for (const secret of [
      'hidden-system',
      'private-user',
      'private-reasoning',
      'secret-token',
      'private-endpoint',
      'raw-private-prompt',
      'mutated-after-delivery',
    ]) {
      expect(stored).not.toContain(secret)
      expect(copied).not.toContain(secret)
    }
  })

  it('does not attach an HTTP failure to an intentional cancellation', () => {
    const monitor = createLocalModelDiagnostics()
    monitor.begin('local', []).fail(true, failure)
    const observation = monitor.state.runs[0]!
    expect(observation.state).toBe('cancelled')
    expect(observation.failure).toBeUndefined()
    expect(localModelDiagnosticCopy({ ...observation, failure })).not.toContain('HTTP: 400')
  })

  it('keeps unsupported/raw failure details unknown and never infers tokens from message lengths', () => {
    const monitor = createLocalModelDiagnostics()
    monitor.begin('local', [{ role: 'user', content: 'a'.repeat(12000) }]).fail(false, {
      schemaVersion: 9,
      message: 'Raw failure mentioning max_tokens and HTTP 400',
      inputTokens: 12000,
    })
    const observation = monitor.state.runs[0]!
    expect(observation.failure).toBeUndefined()
    const copied = localModelDiagnosticCopy(observation)
    expect(copied).toContain('Eingabetokens (erfasst): nicht ermittelt')
    expect(copied).toContain('HTTP: nicht ermittelt')
    expect(copied).not.toContain('12000')
    expect(JSON.stringify(observation)).not.toContain('Raw failure')
  })

  it('forgets diagnostics on clear and rejects late failures of cleared observations', () => {
    const monitor = createLocalModelDiagnostics()
    for (let index = 0; index < 14; index++) monitor.begin(`model-${index}`, []).fail(false, failure)
    expect(monitor.state.runs).toHaveLength(12)
    const late = monitor.begin('pending', [])
    monitor.clear()
    late.fail(false, failure)
    expect(monitor.state.runs).toEqual([])
  })

  it.each(['length', 'stop'])('does not report an empty %s completion as a completed answer', finishReason => {
    const monitor = createLocalModelDiagnostics()
    const run = monitor.begin('local', [])
    run.finish({ ...result, content: '<think>private</think>', finishReason })
    const observation = monitor.state.runs[0]!
    expect(observation.state).toBe('error')
    expect(observation.output).toBe('')
    expect(observation.finishReason).toBe(finishReason)
    expect(observation.events.at(-1)?.label).toBe(
      finishReason === 'length'
        ? 'Ausgabelimit ohne öffentliche Antwort erreicht'
        : 'Keine öffentliche Antwort vom Modell erhalten'
    )
    expect(JSON.stringify(observation)).not.toContain('private')
  })
  it('preserves a visible answer stopped by its output limit and labels it incomplete', () => {
    const monitor = createLocalModelDiagnostics()
    monitor.begin('local', []).finish({ ...result, finishReason: 'length' })
    expect(monitor.state.runs[0]).toMatchObject({ state: 'done', output: result.content, finishReason: 'length' })
    expect(monitor.state.runs[0]?.events.at(-1)?.label).toBe('Ausgabelimit erreicht · Antwort unvollständig')
  })
  it('does not require public prose when the model returned tool calls', () => {
    const monitor = createLocalModelDiagnostics()
    monitor.begin('local', []).finish({
      ...result,
      content: '',
      finishReason: 'tool_calls',
      rawToolCalls: [{ id: 'call-1', type: 'function', function: { name: 'local_model_status', arguments: '{}' } }],
    })
    expect(monitor.state.runs[0]).toMatchObject({ state: 'done', toolCount: 1 })
    expect(monitor.state.runs[0]?.events.at(-1)?.label).toBe('1 Werkzeugaufrufe vom Modell angefordert')
  })
  it('records only public output and character counts, never input text or private tags', () => {
    const monitor = createLocalModelDiagnostics()
    const run = monitor.begin('local', [{ role: 'system', content: 'secret prompt' }])
    run.delta('<think>private')
    expect(monitor.state.runs[0]?.output).toBe('')
    run.delta('<think>private</think>Öffentlich')
    expect(monitor.state.runs[0]?.output).toBe('Öffentlich')
    expect(JSON.stringify(monitor.state)).not.toContain('secret prompt')
    expect(JSON.stringify(monitor.state)).not.toContain('private')
    run.finish(result, { cachedTokens: 0, promptMs: Number.NaN })
    expect(monitor.state.runs[0]?.usage?.totalTokens).toBe(120)
    expect(monitor.state.runs[0]?.runtime.cachedTokens).toBe(0)
    expect(monitor.state.runs[0]?.runtime.promptMs).toBeNull()
  })
  it('does not resurrect cleared, completed, or replaced observations through late events', () => {
    const monitor = createLocalModelDiagnostics()
    const old = monitor.begin('old', [])
    monitor.clear()
    const current = monitor.begin('current', [])
    old.delta('stale')
    old.finish(result)
    expect(monitor.state.runs).toHaveLength(1)
    expect(monitor.state.runs[0]?.output).toBe('')
    current.fail(true)
    current.delta('late')
    current.finish(result)
    expect(monitor.state.runs[0]?.state).toBe('cancelled')
    expect(monitor.state.runs[0]?.output).toBe('')
  })
  it('bounds retained requests and output without altering caller content', () => {
    const monitor = createLocalModelDiagnostics()
    const old = monitor.begin('old', [])
    for (let index = 0; index < 15; index++) monitor.begin(`model-${index}`, [])
    old.finish(result)
    expect(monitor.state.runs).toHaveLength(12)
    const run = monitor.begin('large', [])
    const long = { ...result, content: 'a'.repeat(25_000) }
    run.finish(long)
    expect(monitor.state.runs[0]?.output).toHaveLength(24_000)
    expect(monitor.state.runs[0]?.outputTruncated).toBe(true)
    expect(long.content).toHaveLength(25_000)
  })
  it('retains last public partial answer on failure and rejects malformed context', () => {
    const monitor = createLocalModelDiagnostics()
    const run = monitor.begin('local', [])
    run.delta('Teilantwort')
    run.fail(false)
    expect(monitor.state.runs[0]?.output).toBe('Teilantwort')
    expect(monitor.state.runs[0]?.state).toBe('error')
    const next = monitor.begin('local', [])
    next.finish({
      ...result,
      contextUsage: {
        inputTokens: -1,
        outputTokens: 2,
        contextTokens: 128,
        omittedMessages: 0,
        shortenedToolResults: 0,
      },
    })
    expect(monitor.state.runs[0]?.context).toBeUndefined()
  })
  it('shares numeric observations without output, message summaries or failures', () => {
    const owner = createLocalModelDiagnostics(() => 100)
    const current = owner.begin('model', [{ role: 'user', content: 'private message' }])
    current.delta('private answer')
    current.finish({ ...result, content: 'private answer' }, { outputTokensPerSecond: 12 })
    const snapshot = owner.numericSnapshot()
    expect(JSON.stringify(snapshot)).not.toMatch(/private|outputTruncated|roles|events|failure/)
    const viewer = createLocalModelDiagnostics()
    viewer.acceptNumericSnapshot(snapshot)
    expect(viewer.state.runs[0]).toMatchObject({
      model: 'model',
      state: 'done',
      remote: true,
      output: '',
      roles: [],
      events: [],
      runtime: { outputTokensPerSecond: 12 },
    })
    expect(viewer.numericSnapshot()).toEqual([])
  })
  it('rejects injected content and invalid measurements while retaining local observations', () => {
    const viewer = createLocalModelDiagnostics(() => 100)
    const local = viewer.begin('own', [])
    viewer.acceptNumericSnapshot([
      {
        id: 1000,
        model: 'remote',
        startedAt: 200,
        endedAt: null,
        state: 'responding',
        output: 'secret',
        roles: ['secret'],
        events: ['secret'],
        failure: { reason: 'secret' },
        runtime: { outputTokensPerSecond: Infinity },
        context: { inputTokens: -1 },
      },
      { id: -1, model: 'bad', startedAt: 100, state: 'done' },
    ])
    expect(viewer.state.runs).toHaveLength(2)
    expect(viewer.state.runs[0]).toMatchObject({
      remote: true,
      output: '',
      roles: [],
      events: [],
      runtime: { outputTokensPerSecond: null },
    })
    expect(viewer.state.runs[0]?.context).toBeUndefined()
    expect(JSON.stringify(viewer.state)).not.toContain('secret')
    local.delta('local still active')
    expect(viewer.state.runs.find(run => run.model === 'own')?.output).toBe('local still active')
    expect(viewer.numericSnapshot().map(run => run.model)).toEqual(['own'])
  })
})
