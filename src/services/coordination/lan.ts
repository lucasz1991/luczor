import { reactive } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Store } from '@tauri-apps/plugin-store'
import type { VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig } from '@/services/api/luczorApi'
import { executionGate, invokeGuarded } from '@/services/executionGate'
import { projectLocalIdForServer } from '@/services/cloudProjectAccess'
import { sha256, decodeBase64 } from './binaryTransport'
import { hasActiveChatRuns } from '@/services/chatRunManager'
import { coordinationMetadata } from './preferences'

type Identity = {
  protocol_version: 1
  user_id: number
  client_id: string
  cert_sha256: string
  issued_at: string
  expires_at: string
  algorithm: string
  signature: string
}
export type Envelope = {
  id: string
  fromDeviceId: string
  toDeviceId: string
  kind: 'job' | 'result' | 'chunk' | 'progress'
  payload: Record<string, unknown>
}
export type LanPresence = {
  protocol: number
  ready: boolean
  busy: boolean
  modelId?: string | null
  platform?: string
  tier?: number
}
type LanStatus = {
  active: boolean
  peers: string[]
  reachablePeers?: string[]
  workers?: Record<string, LanPresence>
  discoveryError?: string | null
}
export type AgentLease = {
  protocol_version: 1
  scope: 'agent.read'
  user_id: number
  source_device_id: string
  target_device_ids: string[]
  epoch: number
  issued_at: string
  expires_at: string
  algorithm: string
  signature: string
}
type TrustCache = { signed: Identity; peers: Identity[] }
export const lanState = reactive({
  active: false,
  peers: [] as string[],
  reachablePeers: [] as string[],
  workers: {} as Record<string, LanPresence>,
  authorityEpoch: 0,
  lease: null as AgentLease | null,
  cachedTrust: false,
  serverOnline: false,
  error: '',
  transferred: 0,
  received: [] as Array<{ id: string; from: string; kind: string; payload: Record<string, unknown> }>,
})
let owner: VerifiedAccountSnapshot | null = null
let stopCurrent: (() => void) | null = null
let signature = ''
let transition: Promise<void> = Promise.resolve()
let stopNative: Promise<unknown> = Promise.resolve()
let resultDisk: Promise<Store> | undefined
let trustDisk: Promise<Store> | undefined
let refreshPending: Promise<void> | null = null
let refreshAt = 0
const trustKey = (account: VerifiedAccountSnapshot) => `${account.principalId}:${account.config.clientId}`
const chunks = new Map<
  string,
  { hash: string; from: string; resolve: (bytes: Uint8Array<ArrayBuffer> | null) => void }
>()
export async function refreshLan(account: VerifiedAccountSnapshot, signal: AbortSignal): Promise<void> {
  if (refreshPending) return refreshPending
  if (owner?.principalId === account.principalId && lanState.active && Date.now() < refreshAt) return
  const work = transition.catch(() => {}).then(() => configureLan(account, signal))
  transition = work
  refreshPending = work
  try {
    await work
  } finally {
    refreshPending = null
    refreshAt = Date.now() + 20_000
  }
}
async function configureLan(account: VerifiedAccountSnapshot, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const disk = await (trustDisk ??= Store.load('luczor.lan-trust.json'))
  const key = trustKey(account)
  if (!lanState.active || owner?.principalId !== account.principalId) {
    const cached = await disk.get<TrustCache>(key)
    if (cached) {
      try {
        await activateLan(
          account,
          signal,
          cached.signed,
          cached.peers.filter(peer => Date.parse(peer.expires_at) > Date.now())
        )
        lanState.cachedTrust = true
        lanState.lease = (await disk.get<AgentLease>(`${key}:lease`)) ?? null
      } catch {
        signal.throwIfAborted() /* Native signature/expiry check rejects unusable cached trust. */
      }
    }
  }
  try {
    const networkSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)])
    const identity = await invoke<{ certSha256: string }>('lan_peer_identity')
    const signed = (
      await requestWithConfig<{ data: Identity }>(
        '/coordination/identity',
        { method: 'POST', body: { cert_sha256: identity.certSha256 }, signal: networkSignal },
        account.config
      )
    ).data
    const peers = (
      await requestWithConfig<{ data: Identity[] }>(
        '/coordination/identities',
        { signal: networkSignal },
        account.config
      )
    ).data
    signal.throwIfAborted()
    await activateLan(account, signal, signed, peers)
    await disk.set(key, { signed, peers })
    await disk.save()
    lanState.cachedTrust = false
    lanState.serverOnline = true
  } catch (error) {
    signal.throwIfAborted()
    lanState.serverOnline = false
    const status = (error as { status?: number })?.status
    if (status === 401 || status === 403) {
      stopLan()
      await disk.delete(key)
      await disk.delete(`${key}:lease`)
      await disk.save()
    }
    if (!lanState.active) throw error
  }
}
async function activateLan(account: VerifiedAccountSnapshot, signal: AbortSignal, signed: Identity, peers: Identity[]) {
  if (signed.user_id !== account.accountId || signed.client_id !== account.config.clientId)
    throw new Error('lan_account_mismatch')
  const nextSignature = JSON.stringify([signed, peers])
  if (owner?.principalId === account.principalId && nextSignature === signature && lanState.active) return
  stopCurrent?.()
  await stopNative
  signal.throwIfAborted()
  const ticket = executionGate.capture(signal)
  const status = await invokeGuarded<LanStatus>(
    'lan_peer_start',
    { principalId: account.principalId, deviceId: account.config.clientId, signedIdentity: signed, peers },
    ticket,
    false
  )
  if (signal.aborted) {
    await invoke('lan_peer_stop').catch(() => {})
    signal.throwIfAborted()
  }
  owner = account
  signature = nextSignature
  lanState.active = status.active
  lanState.peers = status.peers.filter(id => id !== account.config.clientId)
  lanState.error = ''
  let notify: (() => void) | undefined
  let timer: (() => void) | undefined
  const stop = () => {
    notify?.()
    timer?.()
    signal.removeEventListener('abort', stop)
    if (owner === account) {
      owner = null
      signature = ''
      lanState.active = false
      lanState.peers = []
      lanState.reachablePeers = []
      lanState.workers = {}
      lanState.lease = null
      lanState.authorityEpoch = 0
      lanState.received = []
      chunks.forEach(pending => pending.resolve(null))
      chunks.clear()
      stopNative = invoke('lan_peer_stop').catch(() => {})
    }
    if (stopCurrent === stop) stopCurrent = null
  }
  stopCurrent = stop
  signal.addEventListener('abort', stop, { once: true })
  try {
    const archive = await (resultDisk ??= Store.load('luczor.lan-results.json'))
    const saved = await archive.entries<Envelope>()
    signal.throwIfAborted()
    if (owner !== account) return
    lanState.received = saved
      .filter(
        ([key, value]) =>
          key.startsWith(`${account.principalId}:`) &&
          value.kind === 'result' &&
          value.toDeviceId === account.config.clientId
      )
      .slice(-100)
      .map(([, value]) => ({ id: value.id, from: value.fromDeviceId, kind: value.kind, payload: value.payload }))
    let draining = false
    const drain = async () => {
      if (draining || signal.aborted || owner !== account) return
      draining = true
      try {
        const metadata = await coordinationMetadata(account)
        const status = await invoke<LanStatus>('lan_peer_status', {
          payload: {
            principalId: account.principalId,
            authorityEpoch: lanState.authorityEpoch,
            presence: {
              protocol: 1,
              ready: metadata.model_ready,
              busy: hasActiveChatRuns() || (await import('./lanAgents')).hasLanAgentRuns(),
              modelId: metadata.active_model_id,
              platform: metadata.platform,
              tier: metadata.model_tier,
            },
          },
        })
        lanState.active = status.active
        lanState.peers = status.peers.filter(id => id !== account.config.clientId)
        lanState.reachablePeers = (status.reachablePeers ?? []).filter(id => id !== account.config.clientId)
        lanState.workers = status.workers ?? {}
        lanState.error = status.discoveryError ?? ''
        await (await import('./lanAgents')).recoverLanAgentResults(account, ticket.signal)
        const received = await invoke<Envelope[]>('lan_peer_drain', { payload: { principalId: account.principalId } })
        for (const envelope of received) {
          if (signal.aborted || owner !== account) return
          if (
            envelope.toDeviceId !== account.config.clientId ||
            !peers.some(peer => peer.client_id === envelope.fromDeviceId)
          )
            throw new Error('Die lokale Gerätenachricht ist nicht zugeordnet.')
          if (envelope.kind === 'job' && envelope.payload.protocol === 'luczor.agent.v1') {
            await (await import('./lanAgents')).receiveLanAgent(envelope, account, ticket.signal)
          } else if (envelope.kind === 'chunk') await receiveChunk(envelope, account, ticket.signal)
          else if (envelope.kind === 'result' || envelope.kind === 'progress') {
            if (envelope.kind === 'result') {
              const disk = await (resultDisk ??= Store.load('luczor.lan-results.json'))
              await disk.set(`${account.principalId}:${envelope.id}`, envelope)
              await disk.save()
            }
            lanState.received = [
              ...lanState.received.filter(item => item.id !== envelope.id),
              { id: envelope.id, from: envelope.fromDeviceId, kind: envelope.kind, payload: envelope.payload },
            ].slice(-100)
            window.dispatchEvent(new CustomEvent('luczor://lan-result', { detail: envelope }))
          }
          // Analysis jobs require a native-verified read lease and journal; legacy jobs only notify server claims.
          await invoke('lan_peer_ack', { payload: { principalId: account.principalId, ids: [envelope.id] } })
        }
        await invoke('lan_peer_flush', { payload: { principalId: account.principalId } })
      } catch (error) {
        if (owner === account && !signal.aborted) {
          lanState.error = error instanceof Error ? error.message : String(error)
          if (/lan_not_started|lan_owner_mismatch|execution|scope/i.test(lanState.error)) lanState.active = false
        }
      } finally {
        draining = false
      }
    }
    notify = await listen('luczor://lan-message', () => {
      void drain()
    })
    timer = await listen('luczor://worker-tick', () => {
      void drain()
    })

    if (signal.aborted) stop()
    else await drain()
  } catch (error) {
    stop()
    throw error
  }
}
export function stopLan() {
  stopCurrent?.()
}
export async function forgetLanTrust(account?: VerifiedAccountSnapshot) {
  stopLan()
  const disk = await (trustDisk ??= Store.load('luczor.lan-trust.json'))
  if (account) {
    await disk.delete(trustKey(account))
    await disk.delete(`${trustKey(account)}:lease`)
  } else await disk.clear()
  await disk.save()
}
export async function sendLan(
  target: string,
  kind: Envelope['kind'],
  payload: Record<string, unknown>,
  messageId: string = crypto.randomUUID()
): Promise<boolean> {
  if (!owner || !lanState.active || target === owner.config.clientId) throw new Error('lan_not_started')
  // Native checks the paired identity and persists first, even when discovery temporarily loses the address.
  const result = await invoke<{ delivered: boolean }>('lan_peer_send', {
    payload: {
      principalId: owner.principalId,
      targetDeviceId: target,
      envelope: { id: messageId, fromDeviceId: owner.config.clientId, toDeviceId: target, kind, payload },
    },
  })
  return result.delivered
}
export async function updateLanAuthority(
  account: VerifiedAccountSnapshot,
  epoch: number,
  leader: string | null,
  signal: AbortSignal
) {
  if (!Number.isSafeInteger(epoch) || epoch < 0) return
  signal.throwIfAborted()
  if (owner !== account || !lanState.active) return
  lanState.authorityEpoch = Math.max(lanState.authorityEpoch, epoch)
  await invoke('lan_peer_status', {
    payload: { principalId: account.principalId, authorityEpoch: lanState.authorityEpoch },
  })
  signal.throwIfAborted()
  if (owner !== account) return
  if (leader !== account.config.clientId) {
    lanState.lease = null
    return
  }
  const previous = lanState.lease
  if (
    previous?.epoch === epoch &&
    Date.parse(previous.expires_at) - Date.now() > 5 * 60_000 &&
    lanState.peers.every(id => previous.target_device_ids.includes(id))
  )
    return
  const { data } = await requestWithConfig<{ data: AgentLease }>(
    '/coordination/agent-lease',
    { method: 'POST', body: { epoch }, signal },
    account.config
  )
  signal.throwIfAborted()
  if (owner !== account || lanState.authorityEpoch !== epoch) return
  lanState.lease = data
  const disk = await (trustDisk ??= Store.load('luczor.lan-trust.json'))
  await disk.set(`${trustKey(account)}:lease`, data)
  await disk.save()
}
async function receiveChunk(envelope: Envelope, account: VerifiedAccountSnapshot, signal: AbortSignal) {
  const payload = envelope.payload
  if (
    typeof payload.requestId !== 'string' ||
    typeof payload.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.sha256)
  )
    return
  if (payload.operation === 'response') {
    const pending = chunks.get(payload.requestId)
    if (!pending || pending.from !== envelope.fromDeviceId || pending.hash !== payload.sha256) return
    if (typeof payload.dataBase64 !== 'string') {
      pending.resolve(null)
      return
    }
    const bytes = decodeBase64(payload.dataBase64)
    if ((await sha256(bytes)) !== pending.hash) throw new Error('Der LAN-Dateiblock hat eine ungültige Prüfsumme.')
    lanState.transferred += bytes.length
    pending.resolve(bytes)
  } else if (payload.operation === 'request' && typeof payload.projectId === 'string') {
    let dataBase64: string | undefined
    try {
      const projectId = projectLocalIdForServer(payload.projectId, account.principalId)
      const ticket = executionGate.capture(signal, { projectId, runId: `lan-chunk:${crypto.randomUUID()}` })
      const block = await invokeGuarded<{ dataBase64: string }>(
        'project_mirror_chunk_read',
        { principalId: account.principalId, projectId, sha256: payload.sha256 },
        ticket,
        false
      )
      dataBase64 = block.dataBase64
    } catch {
      /* Missing chunks fall back to the authenticated server, never another filesystem path. */
    }
    await sendLan(envelope.fromDeviceId, 'chunk', {
      operation: 'response',
      requestId: payload.requestId,
      sha256: payload.sha256,
      ...(dataBase64 ? { dataBase64 } : {}),
    })
  }
}
export async function readLanChunk(
  projectId: string,
  hash: string,
  preferred: string | null,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!owner || !lanState.active || signal?.aborted) return null
  const target = preferred && lanState.peers.includes(preferred) ? preferred : lanState.peers[0]
  if (!target) return null
  const requestId = crypto.randomUUID()
  return new Promise(resolve => {
    const finish = (bytes: Uint8Array<ArrayBuffer> | null) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      chunks.delete(requestId)
      resolve(bytes)
    }
    const abort = () => finish(null)
    const timer = setTimeout(() => finish(null), 1500)
    chunks.set(requestId, { hash, from: target, resolve: finish })
    signal?.addEventListener('abort', abort, { once: true })
    void sendLan(target, 'chunk', { operation: 'request', requestId, projectId, sha256: hash })
      .then(delivered => {
        if (!delivered) finish(null)
      })
      .catch(() => finish(null))
  })
}
