import { WorkflowOperations, WorkflowOperationUncertain } from './operations'
import type { Workflow, WorkflowRun, WorkflowTask, WorkflowTrigger } from './types'

export type EditorRecord = { id: number; name?: string; status?: string; mode?: string; [key: string]: unknown }
export type WorkflowEditorState = {
  workflow: Workflow
  catalog: WorkflowTask[]
  tests: EditorRecord[]
  testCases: EditorRecord[]
  repairs: EditorRecord[]
  runs: WorkflowRun[]
  triggers: WorkflowTrigger[]
  capabilities: { deviceBound: boolean; canRunRealTests: boolean; canConfigureRepairPolicy: boolean }
  urls: { save: string; testCases: string; tests: string; repairs: string; operation: string; runControls?: string }
}
function sameOriginPath(path: string) {
  const url = new URL(path, window.location.origin)
  if (
    url.origin !== window.location.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !/^\/dashboard\/workflows\/\d+(?:\/|$)/u.test(url.pathname)
  )
    throw new Error('Ungültiges Workflow-Ziel.')
  return url.pathname + url.search
}
/** Session cookies/CSRF for Blade; no device key or native authorization is fabricated. */
export function createWorkflowWebSession(stateUrl: string) {
  const url = sameOriginPath(stateUrl)
  let state: WorkflowEditorState | null = null
  const lifetime = new AbortController()
  const storageKey = `luczor.workflow.web.operations:${url}`
  const operations = new WorkflowOperations({
    uuid: () => crypto.randomUUID(),
    open: async () => ({
      get: async <T>() => JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as T | undefined,
      set: async (_key, value) => sessionStorage.setItem(storageKey, JSON.stringify(value)),
      save: async () => {},
    }),
  })
  async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content
    if (method !== 'GET' && !csrf)
      throw new Error('Die Sitzung besitzt keinen gültigen CSRF-Schutz. Bitte die Seite neu laden.')
    const response = await fetch(sameOriginPath(path), {
      method,
      credentials: 'same-origin',
      redirect: 'error',
      signal: lifetime.signal,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if ([401, 403, 419].includes(response.status))
      throw new Error('Die Benutzersitzung oder Workflow-Zuordnung ist nicht mehr gültig. Bitte die Seite neu laden.')
    const payload = await response.json()
    if (!response.ok)
      throw new Error(
        typeof payload?.message === 'string'
          ? payload.message.slice(0, 1500)
          : `Workflow-Anfrage fehlgeschlagen (${response.status}).`
      )
    return payload as T
  }
  async function refresh() {
    state = await request<WorkflowEditorState>(url)
    return state
  }
  async function mutate<T>(kind: keyof WorkflowEditorState['urls'], body: Record<string, unknown>) {
    if (!state) throw new Error('Workflow zuerst laden.')
    const current = state
    const path = Reflect.get(current.urls, kind) as string
    if (typeof path !== 'string') throw new Error('Diese Workflow-Funktion benötigt eine aktualisierte Serverversion.')
    return operations.run<T>({
      scope: [window.location.origin, current.workflow.id],
      args: { kind, body },
      assertCurrent: async () => {
        const fresh = await request<WorkflowEditorState>(url)
        if (fresh.workflow.id !== current.workflow.id) throw new Error('Der Workflow wurde gewechselt.')
      },
      verify: async operationId => {
        const found = await request<{ status: string; response?: T }>(
          `${current.urls.operation}/${encodeURIComponent(operationId)}`
        )
        if (found.status === 'not_found') return null
        if (found.status !== 'completed' || found.response === undefined)
          throw new WorkflowOperationUncertain(operationId)
        return found.response
      },
      execute: operationId =>
        request<T>(path, kind === 'save' ? 'PUT' : 'POST', { ...body, operation_id: operationId }),
    })
  }
  return { refresh, mutate, dispose: () => lifetime.abort() }
}
