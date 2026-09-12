import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdaptiveAssistance, type AssistanceTask } from '@/services/agents/adaptiveAssistance'
import { validateToolArguments } from '@/services/tools/validateArguments'

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
  it('returns external jobs immediately, allows independent overlap and collects each result once', async () => {
    const first = deferred(),
      second = deferred()
    const execute = vi.fn(async (task: AssistanceTask) => (task.task === 'First job' ? first.promise : second.promise))
    const f = fixture(execute)
    const one = await f.delegate('First job'),
      two = await f.delegate('Second job')
    expect(one.status).toBe('running')
    expect(two.status).toBe('running')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(f.manager.hasUncollected()).toBe(true)
    const waiting = f.call('agent_assist_status', { job_id: one.job_id, wait: true })
    first.resolve({ output: 'First result' })
    expect(await waiting).toMatchObject({ status: 'completed', output: { output: 'First result' } })
    second.resolve({ output: 'Second result' })
    expect(await f.manager.collect()).toEqual([expect.objectContaining({ job_id: two.job_id, status: 'completed' })])
    expect(await f.manager.collect()).toEqual([])
    expect(f.manager.hasUncollected()).toBe(false)
    f.manager.dispose()
  })

  it('waits for local work and returns it as already collected', async () => {
    const done = deferred()
    const f = fixture(vi.fn(async () => done.promise))
    let resolved = false
    const pending = f.delegate('Local job', 'local', ['project_get_state']).then(value => {
      resolved = true
      return value
    })
    await Promise.resolve()
    expect(resolved).toBe(false)
    done.resolve({ output: 'Local result' })
    expect(await pending).toMatchObject({ status: 'completed', target: 'local' })
    expect(f.manager.hasUncollected()).toBe(false)
    f.manager.dispose()
  })

  it('rejects repeated jobs, foreign job IDs and unassigned tools before dispatch', async () => {
    const f = fixture()
    await f.delegate('Shared job')
    await expect(f.delegate('Shared job')).rejects.toThrow('bereits gestartet')
    await expect(f.call('agent_assist_status', { job_id: 'another-turn' })).rejects.toThrow('dieser Anfrage')
    await expect(f.delegate('Bad tool job', 'external', ['fs_read'])).rejects.toThrow('Werkzeug')
    await expect(f.delegate('Bad local job', 'local', ['fs_write'])).rejects.toThrow('Werkzeug')
    expect(f.execute).toHaveBeenCalledTimes(1)
    f.manager.dispose()
  })

  it('honors both external and context-tool revocation before new jobs', async () => {
    const f = fixture()
    f.revokeTools()
    await expect(f.delegate('Context job', 'external', ['context_read'])).rejects.toThrow('Werkzeug')
    f.revoke()
    await expect(f.delegate('External job')).rejects.toThrow('nicht für externe')
    expect(f.execute).not.toHaveBeenCalled()
    f.manager.dispose()
  })

  it('enforces three simultaneous external jobs and four total jobs', async () => {
    const done = deferred()
    const f = fixture(vi.fn(async () => done.promise))
    await Promise.all(['One job', 'Two job', 'Three job'].map(task => f.delegate(task)))
    await expect(f.delegate('Four job')).rejects.toThrow('Drei Teilaufträge')
    done.resolve({ output: 'Result' })
    await f.manager.collect()
    await f.delegate('Four job')
    await expect(f.delegate('Five job')).rejects.toThrow('vier gezielte')
    f.manager.dispose()
  })

  it.each(['parent', 'dispose'] as const)(
    'aborts waiting jobs on %s completion and drops late results',
    async origin => {
      const done = deferred()
      const signals: AbortSignal[] = []
      const f = fixture(
        vi.fn(async (_task, signal) => {
          signals.push(signal)
          return done.promise
        })
      )
      const started = await f.delegate('Pending job')
      const waiting = f.call('agent_assist_status', { job_id: started.job_id, wait: true })
      if (origin === 'parent') f.abort.abort()
      else f.manager.dispose()
      await expect(waiting).rejects.toThrow()
      expect(signals[0]?.aborted).toBe(true)
      done.resolve({ output: 'Late provider reply' })
      await Promise.resolve()
      expect(f.manager.summaries).toEqual([])
      await expect(f.delegate('Late new job')).rejects.toThrow()
      f.manager.dispose()
    }
  )

  it('validates the model-facing task and tool count at the execution boundary', async () => {
    const f = fixture()
    await expect(f.delegate('x')).rejects.toThrow('Textlänge')
    await expect(f.delegate('Unknown target', 'other')).rejects.toThrow('Wert nicht erlaubt')
    await expect(f.delegate('Many tools', 'local', Array(7).fill('project_get_state'))).rejects.toThrow('Listenlänge')
    expect(f.execute).not.toHaveBeenCalled()
    f.manager.dispose()
  })
})
