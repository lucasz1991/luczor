import type { ToolDef } from '@/services/tools/types'
import type { SpecialistOutcome } from './externalSpecialists'
import type { TokenUsage } from '@/services/tokenUsage'

export type AssistanceTask = {
  task: string
  role: 'planning' | 'research' | 'coding' | 'review'
  target: 'local' | 'external'
  tools: string[]
  context_indices?: number[]
}
type Job = {
  id: string
  task: AssistanceTask
  status: 'running' | 'completed' | 'failed'
  output?: unknown
  error?: string
  delivered: boolean
  promise: Promise<void>
}

/** One parent turn owns all jobs. External workers may overlap local inference; local ones never do. */
export function createAdaptiveAssistance(input: {
  signal: AbortSignal
  externalAllowed: () => boolean
  localTools: string[]
  externalTools: () => string[]
  execute: (task: AssistanceTask, signal: AbortSignal) => Promise<unknown>
}) {
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const jobs = new Map<string, Job>()
  const summaries: SpecialistOutcome[] = []
  let localTail: Promise<unknown> = Promise.resolve()
  const result = (job: Job) => ({
    ok: job.status !== 'failed',
    job_id: job.id,
    target: job.task.target,
    role: job.task.role,
    status: job.status,
    output: job.output,
    error: job.error,
  })
  const tools: ToolDef[] = [
    {
      name: 'agent_assist',
      category: 'app',
      mutating: false,
      requiresApproval: false,
      effects: ['read'],
      description:
        'Delegate one clearly bounded subtask if useful. Simple requests should be answered directly. External jobs return immediately so you can continue other work; local jobs complete sequentially. Collect results with agent_assist_status before your final answer. Never delegate the same work twice.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: { type: 'string', minLength: 5, maxLength: 6000 },
          role: { type: 'string', enum: ['planning', 'research', 'coding', 'review'] },
          target: { type: 'string', enum: ['local', 'external'] },
          context_indices: {
            type: 'array',
            maxItems: 20,
            items: { type: 'integer', minimum: 0 },
            description:
              'Optional indices in the separately permitted external context. The external task uses only this context and the selected role; task stays a local label.',
          },
          tools: {
            type: 'array',
            maxItems: 6,
            items: { type: 'string', maxLength: 80 },
            description: `Optional read-only tools. Local: ${input.localTools.join(', ')}. External when enabled: context_search, context_read.`,
          },
        },
        required: ['task', 'role', 'target'],
      },
      async execute(args) {
        signal.throwIfAborted()
        const task = { ...args, tools: args.tools ?? [] } as AssistanceTask
        if (jobs.size >= 4) throw new Error('Maximal vier gezielte Teilaufträge pro Anfrage.')
        if (task.target === 'external' && !input.externalAllowed())
          throw new Error('Dieser Kontext ist nicht für externe Agenten freigegeben. Bearbeite den Auftrag lokal.')
        const allowed = task.target === 'external' ? input.externalTools() : input.localTools
        if (task.tools.some(name => !allowed.includes(name)))
          throw new Error('Ein angefordertes Werkzeug ist für diesen Teilauftrag nicht verfügbar.')
        if ([...jobs.values()].some(job => job.task.task === task.task && job.task.role === task.role))
          throw new Error('Dieser Teilauftrag wurde bereits gestartet. Rufe seinen Status ab.')
        if (task.target === 'external' && [...jobs.values()].filter(job => job.status === 'running').length >= 3)
          throw new Error('Drei Teilaufträge laufen bereits. Rufe zunächst einen Status ab.')
        const job: Job = {
          id: crypto.randomUUID(),
          task,
          status: 'running',
          delivered: false,
          promise: Promise.resolve(),
        }
        jobs.set(job.id, job)
        const timeout = AbortSignal.timeout(5 * 60_000)
        const jobSignal = AbortSignal.any([signal, timeout])
        let abort: () => void = () => {}
        const stopped = new Promise<never>((_, reject) => {
          abort = () => reject(new DOMException('Teilauftrag unterbrochen.', 'AbortError'))
          jobSignal.addEventListener('abort', abort, { once: true })
        })
        const execute = async () => {
          jobSignal.throwIfAborted()
          return input.execute(task, jobSignal)
        }
        const pending = task.target === 'local' ? localTail.then(execute) : Promise.resolve().then(execute)
        if (task.target === 'local') localTail = pending.catch(() => undefined)
        job.promise = Promise.race([pending, stopped])
          .then(output => {
            jobSignal.throwIfAborted()
            job.output = output
            job.status = 'completed'
            if (
              output &&
              typeof output === 'object' &&
              (('incomplete' in output && output.incomplete === true) ||
                ('status' in output && output.status === 'incomplete'))
            ) {
              job.status = 'failed'
              job.error = 'Der Teilauftrag hat ein Zwischenergebnis geliefert und ist noch nicht abgeschlossen.'
            }
            if (task.target === 'external') summaries.push(output as SpecialistOutcome)
          })
          .catch(error => {
            job.status = 'failed'
            job.error = error instanceof Error ? error.message : String(error)
          })
          .finally(() => jobSignal.removeEventListener('abort', abort))
        if (task.target === 'local') {
          await job.promise
          signal.throwIfAborted()
          job.delivered = true
        }
        return result(job)
      },
    },
    {
      name: 'agent_assist_status',
      category: 'app',
      mutating: false,
      requiresApproval: false,
      effects: ['read'],
      description:
        'Collect a targeted agent result. Omit job_id to list jobs. wait=true waits for that job while other external jobs continue.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { job_id: { type: 'string', maxLength: 80 }, wait: { type: 'boolean' } },
        required: [],
      },
      async execute(args) {
        signal.throwIfAborted()
        if (!args.job_id)
          return [...jobs.values()].map(job => ({ job_id: job.id, status: job.status, target: job.task.target }))
        const job = jobs.get(String(args.job_id))
        if (!job) throw new Error('Teilauftrag gehört nicht zu dieser Anfrage.')
        if (args.wait === true) await job.promise
        signal.throwIfAborted()
        if (job.status !== 'running') job.delivered = true
        return result(job)
      },
    },
  ]
  return {
    tools,
    summaries,
    isLocalJob: (id: unknown) => typeof id === 'string' && jobs.get(id)?.task.target === 'local',
    withUsage(base: TokenUsage): TokenUsage {
      const values = [...jobs.values()].flatMap(job => {
        const output = job.output as { tokenUsage?: TokenUsage } | undefined
        return output?.tokenUsage ? [output.tokenUsage] : []
      })
      if (!values.length) return base
      return {
        ...base,
        inputTokens: base.inputTokens + values.reduce((sum, value) => sum + value.inputTokens, 0),
        outputTokens: base.outputTokens + values.reduce((sum, value) => sum + value.outputTokens, 0),
        totalTokens: base.totalTokens + values.reduce((sum, value) => sum + value.totalTokens, 0),
        rounds: base.rounds + values.reduce((sum, value) => sum + value.rounds, 0),
        source: [base, ...values].every(value => value.source === 'reported') ? 'reported' : 'mixed',
      }
    },
    hasUncollected: () => [...jobs.values()].some(job => !job.delivered),
    async collect() {
      await Promise.all([...jobs.values()].map(job => job.promise))
      signal.throwIfAborted()
      return [...jobs.values()]
        .filter(job => !job.delivered)
        .map(job => {
          job.delivered = true
          return result(job)
        })
    },
    dispose: () => controller.abort(),
  }
}
