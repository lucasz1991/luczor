import type { ToolDef } from '@/services/tools/types'
import type { SpecialistOutcome } from './externalSpecialists'
import type { TokenUsage } from '@/services/tokenUsage'
import { assistanceCompletionIssue } from './researchHarness'

export type AssistanceTask = {
  task: string
  role: 'planning' | 'research' | 'coding' | 'review'
  target: 'local' | 'external' | 'device' | 'auto'
  device_id?: string
  tools: string[]
  context_indices?: number[]
}
type Job = {
  id: string
  task: AssistanceTask
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  controller: AbortController
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
  deviceTools?: () => string[]
  resolveTarget?: (task: AssistanceTask) => Promise<AssistanceTask>
  workers?: () => unknown
  execute: (task: AssistanceTask, signal: AbortSignal) => Promise<unknown>
}) {
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const jobs = new Map<string, Job>()
  const summaries: SpecialistOutcome[] = []
  let localTail: Promise<unknown> = Promise.resolve()
  const result = (job: Job) => ({
    ok: job.status !== 'failed' && job.status !== 'cancelled',
    job_id: job.id,
    target: job.task.target,
    role: job.task.role,
    status: job.status,
    output: job.output,
    error: job.error,
    verification:
      'Parent must verify findings and evidence; completed means a nonempty result, not factual validation.',
  })
  const tools: ToolDef[] = [
    {
      name: 'agent_assist',
      category: 'app',
      mutating: false,
      requiresApproval: false,
      effects: ['read'],
      description:
        'Delegate independent research, analysis or review for substantial tasks. Use target=auto to prefer a ready own-device model, then permitted external assistance. Answer simple requests directly. Device/external jobs return immediately; the same local model runs sequentially. Collect and verify results with agent_assist_status; cancel obsolete jobs with agent_assist_stop. Do not duplicate work. External task text stays a local label: select permitted context_indices.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: { type: 'string', minLength: 5, maxLength: 6000 },
          role: { type: 'string', enum: ['planning', 'research', 'coding', 'review'] },
          target: { type: 'string', enum: ['auto', 'local', 'device', 'external'] },
          device_id: {
            type: 'string',
            minLength: 1,
            maxLength: 190,
            description: 'Optional own-device ID from agent_assist_status. Omit for automatic selection.',
          },
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
            description: `Optional read-only tools. Local: ${input.localTools.join(', ')}. Own device: fs_list, fs_stat, fs_read, fs_search, project_get_state, workspace_get, os_environment, os_system_diagnostics, local_model_status; requires shared project mapping. External when enabled: context_search, context_read.`,
          },
        },
        required: ['task', 'role', 'target'],
      },
      async execute(args) {
        signal.throwIfAborted()
        let task = structuredClone({ ...args, tools: args.tools ?? [] }) as AssistanceTask
        if (input.resolveTarget) task = await input.resolveTarget(task)
        signal.throwIfAborted()
        if (task.target === 'auto' || (task.target === 'device' && !task.device_id))
          throw new Error('Kein einsatzbereites Zielgerät verfügbar. agent_assist_status zeigt die verfügbaren Ziele.')
        if (jobs.size >= 4) throw new Error('Maximal vier gezielte Teilaufträge pro Anfrage.')
        if (task.target === 'external' && !input.externalAllowed())
          throw new Error('Dieser Kontext ist nicht für externe Agenten freigegeben. Bearbeite den Auftrag lokal.')
        const allowed =
          task.target === 'external'
            ? input.externalTools()
            : task.target === 'device'
              ? (input.deviceTools?.() ?? [])
              : input.localTools
        if (task.tools.some(name => !allowed.includes(name)))
          throw new Error('Ein angefordertes Werkzeug ist für diesen Teilauftrag nicht verfügbar.')
        if ([...jobs.values()].some(job => job.task.task === task.task && job.task.role === task.role))
          throw new Error('Dieser Teilauftrag wurde bereits gestartet. Rufe seinen Status ab.')
        if (task.target !== 'local' && [...jobs.values()].filter(job => job.status === 'running').length >= 3)
          throw new Error('Drei Teilaufträge laufen bereits. Rufe zunächst einen Status ab.')
        const job: Job = {
          id: crypto.randomUUID(),
          task,
          status: 'running',
          controller: new AbortController(),
          delivered: false,
          promise: Promise.resolve(),
        }
        jobs.set(job.id, job)
        const timeout = AbortSignal.timeout(5 * 60_000)
        const jobSignal = AbortSignal.any([signal, timeout, job.controller.signal])
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
            const issue = assistanceCompletionIssue(output)
            if (issue) {
              job.status = 'failed'
              job.error = `${issue}: Teilauftrag nicht vollständig; vorhandenen Zwischenstand prüfen.`
            }
            if (
              task.target === 'external' &&
              output &&
              typeof output === 'object' &&
              'output' in output &&
              typeof output.output === 'string'
            )
              summaries.push({ ...output, ...(issue ? { incomplete: true } : {}) } as SpecialistOutcome)
          })
          .catch(error => {
            job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
            job.error = job.controller.signal.aborted
              ? 'agent_job_cancelled'
              : error instanceof Error
                ? error.message
                : String(error)
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
        if (!args.job_id) {
          const current = [...jobs.values()].map(job => ({
            job_id: job.id,
            status: job.status,
            target: job.task.target,
            device_id: job.task.device_id,
          }))
          return input.workers ? { jobs: current, workers: input.workers() } : current
        }
        const job = jobs.get(String(args.job_id))
        if (!job) throw new Error('Teilauftrag gehört nicht zu dieser Anfrage.')
        if (args.wait === true) await job.promise
        signal.throwIfAborted()
        if (job.status !== 'running') job.delivered = true
        return result(job)
      },
    },
  ]
  tools.push({
    name: 'agent_assist_stop',
    category: 'app',
    mutating: false,
    requiresApproval: false,
    effects: ['read'],
    description:
      'Cancel one child job belonging to this parent request. Other jobs and the parent continue. Late results are discarded. Cancellation does not undo prior effects.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['job_id'],
    },
    async execute(args) {
      signal.throwIfAborted()
      const job = jobs.get(String(args.job_id))
      if (!job) throw new Error('Teilauftrag gehört nicht zu dieser Anfrage.')
      if (job.status === 'running') {
        job.controller.abort()
        await job.promise
      }
      signal.throwIfAborted()
      return { job_id: job.id, status: job.status, stop_requested: job.controller.signal.aborted }
    },
  })
  return {
    tools,
    summaries,
    isLocalJob: (id: unknown) =>
      typeof id === 'string' && ['local', 'device'].includes(jobs.get(id)?.task.target ?? ''),
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
