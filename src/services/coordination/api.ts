import { requestWithConfig, type DeviceJob, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'

export type CoordinationState = {
  schema_version: 1
  leader_device_id: string | null
  preferred_device_id: string | null
  epoch: number
  lease_expires_at: string | null
  heartbeat_seconds: number
  lease_seconds: number
  role: 'master' | 'assistant'
  handoff_pending: boolean
  devices?: Array<{
    id: number
    client_id: string
    device_id: string
    name?: string
    platform?: string
    available?: boolean
    model_tier?: number | null
    active_model_id?: string | null
    model_tier_source?: 'explicit' | 'published_model' | null
  }>
}
export type CoordinatedJob = DeviceJob & {
  protocol_version: 2
  user_id: number
  source_device_id: string
  target_device_id: string
  project_id: string | null
  conversation_id?: string | null
  master_epoch: number
  authority_epoch?: number
  reconciliation_required?: boolean
  attempt_id: string | null
  lease_expires_at?: string | null
  result?: Record<string, unknown> | null
  cancel_requested?: boolean
}
export function coordinationApi(config: LuczorApiConfigSnapshot, signal?: AbortSignal) {
  const get = <T>(path: string, query?: Record<string, string>) => requestWithConfig<T>(path, { query, signal }, config)
  const post = <T>(path: string, body: unknown) => requestWithConfig<T>(path, { method: 'POST', body, signal }, config)
  const path = (id: string) => `/coordination/jobs/${encodeURIComponent(id)}`
  const pages = async (path: string): Promise<{ data: CoordinatedJob[] }> => {
    const data: CoordinatedJob[] = []
    let after = 0
    while (true) {
      const page = await get<{ data: CoordinatedJob[]; next_cursor: number }>(path, {
        limit: '100',
        after: String(after),
      })
      data.push(...page.data)
      if (page.data.length < 100) return { data }
      if (!Number.isSafeInteger(page.next_cursor) || page.next_cursor <= after)
        throw new Error('Die Auftragsliste konnte nicht vollständig abgerufen werden.')
      after = page.next_cursor
    }
  }
  return {
    state: () => get<{ data: CoordinationState }>('/coordination'),
    heartbeat: (
      busy: boolean,
      available = true,
      metadata: { platform?: string; model_tier?: number; preferred?: boolean; active_model_id?: string | null } = {}
    ) =>
      post<{ data: CoordinationState }>('/coordination/heartbeat', {
        client_id: config.clientId,
        available,
        busy,
        ...metadata,
      }),
    pending: () => pages('/coordination/jobs/pending'),
    jobs: () => pages('/coordination/jobs'),
    job: (id: string) => get<{ data: CoordinatedJob }>(path(id)),
    dispatch: (body: Record<string, unknown>) => post<{ data: CoordinatedJob }>('/coordination/jobs', body),
    claim: (id: string, attemptId: string, epoch: number) =>
      post<{ data: CoordinatedJob }>(`${path(id)}/claim`, { attempt_id: attemptId, master_epoch: epoch }),
    adopt: (id: string, attemptId: string, epoch: number) =>
      post<{ data: CoordinatedJob }>(`${path(id)}/adopt`, { attempt_id: attemptId, master_epoch: epoch }),
    progress: (
      id: string,
      attemptId: string,
      epoch: number,
      sequence: number,
      status: string,
      summary: string,
      authorityEpoch?: number
    ) =>
      post(`${path(id)}/progress`, {
        attempt_id: attemptId,
        master_epoch: epoch,
        sequence,
        status,
        summary,
        authority_epoch: authorityEpoch ?? epoch,
      }),
    complete: (id: string, attemptId: string, epoch: number, result: Record<string, unknown>) =>
      post(`${path(id)}/complete`, { attempt_id: attemptId, master_epoch: epoch, ...result }),
    cancel: (id: string, epoch: number) => post(`${path(id)}/cancel`, { master_epoch: epoch }),
    cancelAck: (id: string, attemptId: string, epoch: number) =>
      post(`${path(id)}/cancel-ack`, { attempt_id: attemptId, master_epoch: epoch }),
  }
}
