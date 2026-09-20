import { Store } from '@tauri-apps/plugin-store'
import type { LuczorApiConfigSnapshot } from '@/services/api/luczorApi'

export type WorkflowExecutionRecord = {
  id: string
  hash: string
  state: 'started' | 'completed' | 'acknowledged'
  result?: Record<string, unknown>
  updatedAt: number
}
export interface WorkflowExecutionStorage {
  read(key: string): Promise<WorkflowExecutionRecord | undefined>
  write(key: string, value: WorkflowExecutionRecord): Promise<void>
}

export async function workflowHash(value: unknown): Promise<string> {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical)
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)])
      )
    return input
  }
  return workflowTextHash(JSON.stringify(canonical(value)))
}

export async function workflowTextHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function workflowAccountScope(config: LuczorApiConfigSnapshot): Promise<string> {
  return workflowHash({ baseUrl: config.baseUrl, clientId: config.clientId, deviceKey: config.deviceKey })
}

const durableStorage: WorkflowExecutionStorage = {
  async read(key) {
    const store = await Store.load('luczor.workflow-executions.json')
    return (await store.get<WorkflowExecutionRecord>(key)) ?? undefined
  },
  async write(key, value) {
    const store = await Store.load('luczor.workflow-executions.json')
    await store.set(key, value)
    await store.save()
  },
}

/** A durable started marker is written before effects. An uncertain invocation never runs again implicitly. */
export function createWorkflowExecutionLedger(storage: WorkflowExecutionStorage = durableStorage) {
  const locks = new Map<string, symbol>()
  let generation = 0
  return {
    /** A native-confirmed stop frees local locks, but keeps durable uncertain-effect markers. */
    recoverAfterStop(): void {
      generation++
      locks.clear()
    },
    async recover(scope: string, id: string, payload: unknown) {
      const record = await storage.read(`${scope}:${id}`)
      if (!record) return undefined
      if (record.hash !== (await workflowHash(payload))) throw new Error('workflow_execution_payload_conflict')
      if (record.state === 'started') throw new Error('workflow_execution_outcome_unknown')
      if (!record.result || typeof record.result !== 'object') throw new Error('workflow_execution_record_invalid')
      return record.result
    },
    async execute(scope: string, id: string, payload: unknown, execute: () => Promise<Record<string, unknown>>) {
      const key = `${scope}:${id}`
      if (locks.has(key)) throw new Error('workflow_execution_busy')
      const owner = Symbol(id)
      const epoch = generation
      const assertCurrent = () => {
        if (epoch !== generation) throw new Error('workflow_execution_stopped')
      }
      locks.set(key, owner)
      try {
        const hash = await workflowHash(payload)
        assertCurrent()
        const previous = await storage.read(key)
        assertCurrent()
        if (previous) {
          // Request fingerprints contain no secrets and are compared locally, not across a remote authentication boundary.
          // eslint-disable-next-line security/detect-possible-timing-attacks
          if (previous.hash !== hash) throw new Error('workflow_execution_payload_conflict')
          if (previous.state === 'started') throw new Error('workflow_execution_outcome_unknown')
          if (!previous.result || typeof previous.result !== 'object')
            throw new Error('workflow_execution_record_invalid')
          return previous.result
        }
        await storage.write(key, { id, hash, state: 'started', updatedAt: Date.now() })
        assertCurrent()
        const result = await execute()
        assertCurrent()
        await storage.write(key, { id, hash, state: 'completed', result, updatedAt: Date.now() })
        return result
      } finally {
        if (locks.get(key) === owner) locks.delete(key)
      }
    },
    async acknowledge(scope: string, id: string) {
      const key = `${scope}:${id}`
      const record = await storage.read(key)
      if (record?.state === 'completed')
        await storage.write(key, { ...record, state: 'acknowledged', updatedAt: Date.now() })
    },
  }
}

export const workflowExecutionLedger = createWorkflowExecutionLedger()
