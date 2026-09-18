import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdaptiveAssistance, type AssistanceTask } from '@/services/agents/adaptiveAssistance'
import { validateToolArguments } from '@/services/tools/validateArguments'
import { teamMessages } from '@/services/agents/chatCheckpoint'

function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(
  execute = vi.fn(async (_task: AssistanceTask, _signal: AbortSignal): Promise<unknown> => ({ output: 'Result' }))
) {
  const abort = new AbortController()
  let externalAllowed = true
  let externalTools = true
  const manager = createAdaptiveAssistance({
    signal: abort.signal,
    externalAllowed: () => externalAllowed,
    localTools: ['project_get_state'],
    externalTools: () => (externalTools ? ['context_read'] : []),
    execute,
  })
  async function call(name: string, args: Record<string, unknown>) {
    const tool = manager.tools.find(tool => tool.name === name)!
    validateToolArguments(tool.parameters, args)
    return (await tool.execute(args, { projectId: 'project' })) as Record<string, unknown>
  }
  return {
    manager,
    abort,
    call,
    execute,
    delegate: (task: string, target = 'external', tools: string[] = []) =>
      call('agent_assist', { task, target, tools, role: 'research' }),
    revoke: () => {
      externalAllowed = false
    },
    revokeTools: () => {
      externalTools = false
    },
  }
}

afterEach(() => vi.restoreAllMocks())
describe('bounded adaptive assistance lifetime', () => {
  it.each([
    [undefined, 'agent_result_missing'],
    [{ output: '  ' }, 'agent_result_empty'],
    [{ output: 'Partial evidence', ok: false }, 'agent_result_failed'],
    [{ output: 'Partial evidence', status: 'failed' }, 'agent_result_failed'],
    [{ output: 'Partial evidence', incomplete: true }, 'agent_result_incomplete'],
    [{ output: 'Partial evidence', finishReason: 'length' }, 'agent_result_incomplete'],
  ])('does not treat invalid or partial result %j as completed', async (output, code) => {
    const state = fixture(vi.fn(async () => output))
    await state.delegate('Check evidence')
    const results = await state.manager.collect()
    expect(results[0]).toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining(String(code)) })
    expect(state.manager.summaries.every(item => item.incomplete)).toBe(true)
    state.manager.dispose()
  })

  it('cancels only one job, discards its late reply and leaves the other result collectable', async () => {
    const first = deferred(),
      second = deferred()
    const state = fixture(vi.fn(async task => (task.task === 'First job' ? first.promise : second.promise)))
    const one = await state.delegate('First job'),
      two = await state.delegate('Second job')
    await expect(state.call('agent_assist_stop', { job_id: 'foreign' })).rejects.toThrow('dieser Anfrage')
    expect(await state.call('agent_assist_stop', { job_id: one.job_id })).toMatchObject({
      status: 'cancelled',
      stop_requested: true,
    })
    first.resolve({ output: 'Stale result' })
    second.resolve({ output: 'Usable evidence' })
    const results = await state.manager.collect()
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ job_id: one.job_id, status: 'cancelled', ok: false }),
        expect.objectContaining({ job_id: two.job_id, status: 'completed', output: { output: 'Usable evidence' } }),
      ])
    )
    expect(state.manager.summaries.map(item => item.output)).toEqual(['Usable evidence'])
    expect(state.abort.signal.aborted).toBe(false)
    expect(await state.call('agent_assist_stop', { job_id: two.job_id })).toMatchObject({
      status: 'completed',
      stop_requested: false,
    })
    state.manager.dispose()
  })

  it('preserves exact Unicode file references and valid tool JSON across team handoffs', () => {
    const path = 'reports/Prüfung-e\u0301-2026-09-17.md'
    const source = [
      {
        role: 'tool' as const,
        name: 'fs_read',
        tool_call_id: 'read1',
        content: JSON.stringify({ path, file_ref: 'file_abc', content: 'Evidence\n'.repeat(1000) }),
      },
    ]
    const original = source[0]!.content
    const handoff = teamMessages(source)
    const projected = JSON.parse(handoff[0]!.content)
    expect(projected.path).toBe(path)
    expect(projected.file_ref).toBe('file_abc')
    expect(handoff[0]!.content).toBe(original)
    expect(handoff[0]).toMatchObject({ role: 'tool', tool_call_id: 'read1' })
    expect(source[0]!.content).toBe(original)
  })
  it('returns external jobs immediately, allows independent overlap and collects each result once', async () => {
    const first = deferred(),
      second = deferred()
    const execute = vi.fn(async (task: AssistanceTask) => (task.task === 'First job' ? first.promise : second.promise))
    const fixtureState = fixture(execute)
    const one = await fixtureState.delegate('First job'),
      two = await fixtureState.delegate('Second job')
    expect(one.status).toBe('running')
    expect(two.status).toBe('running')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(fixtureState.manager.hasUncollected()).toBe(true)
    const waiting = fixtureState.call('agent_assist_status', { job_id: one.job_id, wait: true })
    first.resolve({ output: 'First result' })
    expect(await waiting).toMatchObject({ status: 'completed', output: { output: 'First result' } })
    second.resolve({ output: 'Second result' })
    expect(await fixtureState.manager.collect()).toEqual([
      expect.objectContaining({ job_id: two.job_id, status: 'completed' }),
    ])
    expect(await fixtureState.manager.collect()).toEqual([])
    expect(fixtureState.manager.hasUncollected()).toBe(false)
    fixtureState.manager.dispose()
  })

  it('waits for local work and returns it as already collected', async () => {
    const done = deferred()
    const fixtureState = fixture(vi.fn(async () => done.promise))
    let resolved = false
    const pending = fixtureState.delegate('Local job', 'local', ['project_get_state']).then(value => {
      resolved = true
      return value
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    done.resolve({ output: 'Local result' })
    expect(await pending).toMatchObject({ status: 'completed', target: 'local' })
    expect(fixtureState.manager.hasUncollected()).toBe(false)
    fixtureState.manager.dispose()
  })

  it('rejects repeated jobs, foreign job IDs and unassigned tools before dispatch', async () => {
    const fixtureState = fixture()
    await fixtureState.delegate('Shared job')
    await expect(fixtureState.delegate('Shared job')).rejects.toThrow('bereits gestartet')
    await expect(fixtureState.call('agent_assist_status', { job_id: 'another-turn' })).rejects.toThrow('dieser Anfrage')
    await expect(fixtureState.delegate('Bad tool job', 'external', ['fs_read'])).rejects.toThrow('Werkzeug')
    await expect(fixtureState.delegate('Bad local job', 'local', ['fs_write'])).rejects.toThrow('Werkzeug')
    expect(fixtureState.execute).toHaveBeenCalledTimes(1)
    fixtureState.manager.dispose()
  })

  it('honors both external and context-tool revocation before new jobs', async () => {
    const fixtureState = fixture()
    fixtureState.revokeTools()
    await expect(fixtureState.delegate('Context job', 'external', ['context_read'])).rejects.toThrow('Werkzeug')
    fixtureState.revoke()
    await expect(fixtureState.delegate('External job')).rejects.toThrow('nicht für externe')
    expect(fixtureState.execute).not.toHaveBeenCalled()
    fixtureState.manager.dispose()
  })

  it('enforces three simultaneous external jobs and four total jobs', async () => {
    const done = deferred()
    const fixtureState = fixture(vi.fn(async () => done.promise))
    await Promise.all(['One job', 'Two job', 'Three job'].map(task => fixtureState.delegate(task)))
    await expect(fixtureState.delegate('Four job')).rejects.toThrow('Drei Teilaufträge')
    done.resolve({ output: 'Result' })
    await fixtureState.manager.collect()
    await fixtureState.delegate('Four job')
    await expect(fixtureState.delegate('Five job')).rejects.toThrow('vier gezielte')
    fixtureState.manager.dispose()
  })

  it.each(['parent', 'dispose'] as const)(
    'aborts waiting jobs on %s completion and drops late results',
    async origin => {
      const done = deferred()
      const signals: AbortSignal[] = []
      const fixtureState = fixture(
        vi.fn(async (_task, signal) => {
          signals.push(signal)
          return done.promise
        })
      )
      const started = await fixtureState.delegate('Pending job')
      const waiting = fixtureState.call('agent_assist_status', { job_id: started.job_id, wait: true })
      if (origin === 'parent') fixtureState.abort.abort()
      else fixtureState.manager.dispose()
      await expect(waiting).rejects.toThrow()
      expect(signals[0]?.aborted).toBe(true)
      done.resolve({ output: 'Late provider reply' })
      await Promise.resolve()
      expect(fixtureState.manager.summaries).toEqual([])
      await expect(fixtureState.delegate('Late new job')).rejects.toThrow()
      fixtureState.manager.dispose()
    }
  )

  it('validates the model-facing task and tool count at the execution boundary', async () => {
    const fixtureState = fixture()
    await expect(fixtureState.delegate('x')).rejects.toThrow('Textlänge')
    await expect(fixtureState.delegate('Unknown target', 'other')).rejects.toThrow('Wert nicht erlaubt')
    await expect(fixtureState.delegate('Many tools', 'local', Array(7).fill('project_get_state'))).rejects.toThrow(
      'Listenlänge'
    )
    expect(fixtureState.execute).not.toHaveBeenCalled()
    fixtureState.manager.dispose()
  })
})
