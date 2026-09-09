import { describe, expect, it } from 'vitest'
import { createLocalModelDiagnostics } from '@/services/inference/localModelDiagnostics'

const result = {
  content: 'Öffentliche Antwort',
  rawToolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 20, totalTokens: 999 },
}

describe('local model observation boundary', () => {
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
})
