import { Store } from '@tauri-apps/plugin-store'

type Entry = { scope: string; fingerprint: string; operationId: string }
type LedgerStore = { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<unknown>; save(): Promise<unknown> }
export type WorkflowOperationDependencies = { open(): Promise<LedgerStore>; uuid(): string }
const defaultDependencies: WorkflowOperationDependencies = {
  open: () => Store.load('luczor.workflow-operations.json'), uuid: () => crypto.randomUUID(),
}
const digestPattern = /^[a-f0-9]{64}$/u
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu

export function boundedWorkflowJson(value: unknown): string {
  let count = 0
  function visit(item: unknown, depth: number): unknown {
    if (++count > 10_000 || depth > 12) throw new Error('Workflow-Daten sind zu tief oder zu umfangreich.')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (Array.isArray(item)) return item.map(value => visit(value, depth + 1))
    if (typeof item !== 'object' || !item) throw new Error('Workflow-Daten müssen gültiges JSON enthalten.')
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(item).sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Ungültiger Feldname in Workflow-Daten.')
      const member: unknown = Reflect.get(item, key)
      if (member !== undefined) result[key] = visit(member, depth + 1)
    }
    return result
  }
  const encoded = JSON.stringify(visit(value, 0))
  if (new TextEncoder().encode(encoded).byteLength > 256_000) throw new Error('Workflow-Daten überschreiten 256 KB.')
  return encoded
}

export async function workflowDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(boundedWorkflowJson(value)))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export class WorkflowOperationUncertain extends Error {
  readonly code = 'workflow_operation_outcome_unknown'
  constructor(readonly operationId: string) {
    super(`Der Ausgang des Workflow-Auftrags ist unklar. Der nächste Versuch prüft zuerst dieselbe Operations-ID ${operationId}.`)
  }
}

/** Stores only hashes and random IDs; no credentials, workflow content or results. */
export class WorkflowOperations {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly deps: WorkflowOperationDependencies = defaultDependencies) {}
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation)
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }
  private async entries(store: LedgerStore): Promise<Entry[]> {
    const values = await store.get<unknown>('pending') ?? []
    if (!Array.isArray(values) || values.length > 256 || values.some(item =>
      !item || typeof item !== 'object' || !digestPattern.test(item.scope) ||
      !digestPattern.test(item.fingerprint) || !uuidPattern.test(item.operationId))) {
      throw new Error('Der Workflow-Wiederherstellungsspeicher ist ungültig. Es wurde kein Auftrag gesendet.')
    }
    return values as Entry[]
  }
  run<T>(input: {
    scope: unknown; args: unknown; assertCurrent(): Promise<void>;
    verify(operationId: string): Promise<T | null>; execute(operationId: string): Promise<T>;
  }): Promise<T> {
    return this.serialize(async () => {
      const scope = await workflowDigest(input.scope)
      const fingerprint = await workflowDigest(input.args)
      await input.assertCurrent()
      const store = await this.deps.open()
      const entries = await this.entries(store)
      let entry = entries.find(item => item.scope === scope)
      const persist = async () => { await store.set('pending', entries); await store.save() }
      const remove = async () => { const index = entries.indexOf(entry!); if (index >= 0) entries.splice(index, 1); await persist() }
      if (entry) {
        let previous: T | null
        try { previous = await input.verify(entry.operationId) }
        catch { throw new WorkflowOperationUncertain(entry.operationId) }
        await input.assertCurrent()
        if (previous !== null) {
          await remove()
          if (entry.fingerprint !== fingerprint) throw new Error('Ein vorheriger Auftrag wurde wiederhergestellt. Prüfe den aktuellen Workflow vor der nächsten Änderung.')
          return previous
        }
        if (entry.fingerprint !== fingerprint) throw new WorkflowOperationUncertain(entry.operationId)
      } else {
        if (entries.length >= 256) throw new Error('Zu viele offene Workflow-Aufträge. Zuerst bestehende Aufträge wiederherstellen.')
        entry = { scope, fingerprint, operationId: this.deps.uuid() }
        entries.push(entry)
        await persist()
      }
      await input.assertCurrent()
      try {
        const result = await input.execute(entry.operationId)
        // A revoked UI context must not publish the result; keep identity-bound recovery available.
        await input.assertCurrent()
        await remove()
        return result
      } catch (error) {
        const status = error && typeof error === 'object' ? Reflect.get(error, 'status') : undefined
        if (typeof status === 'number' && status >= 400 && status < 500 && ![408, 429].includes(status)) {
          await remove()
          throw error
        }
        throw new WorkflowOperationUncertain(entry.operationId)
      }
    })
  }
}
export const workflowOperations = new WorkflowOperations()
