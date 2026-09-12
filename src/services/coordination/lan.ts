import { reactive } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Store } from '@tauri-apps/plugin-store'
import type { VerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig } from '@/services/api/luczorApi'
import { executionGate, invokeGuarded } from '@/services/executionGate'
import { projectLocalIdForServer } from '@/services/cloudProjectAccess'
import { sha256, decodeBase64 } from './binaryTransport'

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
type Envelope = {
  id: string
  fromDeviceId: string
  toDeviceId: string
  kind: 'job' | 'result' | 'chunk' | 'progress'
  payload: Record<string, unknown>
}
export const lanState = reactive({
  active: false,
  peers: [] as string[],
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
const chunks = new Map<
  string,
  { hash: string; from: string; resolve: (bytes: Uint8Array<ArrayBuffer> | null) => void }
>()
export async function refreshLan(account: VerifiedAccountSnapshot, signal: AbortSignal): Promise<void> {
  const work = transition.catch(() => {}).then(() => configureLan(account, signal))
  transition = work
  return work
}
async function configureLan(account: VerifiedAccountSnapshot, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const identity = await invoke<{ certSha256: string }>('lan_peer_identity')
  const signed = (
    await requestWithConfig<{ data: Identity }>(
      '/coordination/identity',
      { method: 'POST', body: { cert_sha256: identity.certSha256 }, signal },
      account.config
    )
  ).data
  const peers = (await requestWithConfig<{ data: Identity[] }>('/coordination/identities', { signal }, account.config))
    .data
  const nextSignature = JSON.stringify([signed, peers])
  if (owner?.principalId === account.principalId && nextSignature === signature && lanState.active) return
  stopCurrent?.()
  await stopNative
  signal.throwIfAborted()
  const ticket = executionGate.capture(signal)
  const status = await invokeGuarded<{ active: boolean; peers: string[] }>(
    'lan_peer_start',
    { principalId: account.principalId, deviceId: account.config.clientId, signedIdentity: signed, peers },
    ticket,
    false
  )
  owner = account
  signature = nextSignature
  lanState.active = status.active
  lanState.peers = status.peers.filter(id => id !== account.config.clientId)
  lanState.error = ''
  let draining = false
  const drain = async () => {
    if (draining || signal.aborted || owner !== account) return
    draining = true
    try {
      const status = await invoke<{ active: boolean; peers: string[] }>('lan_peer_status', {
        payload: { principalId: account.principalId },
      })
      lanState.active = status.active
      lanState.peers = status.peers.filter(id => id !== account.config.clientId)
      const received = await invoke<Envelope[]>('lan_peer_drain', { payload: { principalId: account.principalId } })
      for (const envelope of received) {
        if (signal.aborted || owner !== account) return
        if (
          envelope.toDeviceId !== account.config.clientId ||
          !peers.some(peer => peer.client_id === envelope.fromDeviceId)
        )
          throw new Error('Die lokale Gerätenachricht ist nicht zugeordnet.')
        if (envelope.kind === 'chunk') await receiveChunk(envelope, account, ticket.signal)
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
        // Job envelopes are notification only. Server claims + native signature checks remain mandatory before effects.
        await invoke('lan_peer_ack', { payload: { principalId: account.principalId, ids: [envelope.id] } })
      }
      await invoke('lan_peer_flush', { payload: { principalId: account.principalId } })
    } catch (error) {
      lanState.error = error instanceof Error ? error.message : String(error)
    } finally {
      draining = false
    }
  }
  const notify = await listen('luczor://lan-message', () => {
    void drain()
  })
  const timer = await listen('luczor://worker-tick', () => {
    void drain()
  })
  const stop = () => {
    notify()
    timer()
    if (owner === account) {
      owner = null
      signature = ''
      lanState.active = false
      lanState.peers = []
      lanState.received = []
      chunks.forEach(pending => pending.resolve(null))
      chunks.clear()
      stopNative = invoke('lan_peer_stop').catch(() => {})
    }
    if (stopCurrent === stop) stopCurrent = null
  }
  stopCurrent = stop
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
  else await drain()
}
export function stopLan() {
  stopCurrent?.()
}
export async function sendLan(
  target: string,
  kind: Envelope['kind'],
  payload: Record<string, unknown>
): Promise<boolean> {
  if (!owner || !lanState.active || target === owner.config.clientId || !lanState.peers.includes(target)) return false
  const result = await invoke<{ delivered: boolean }>('lan_peer_send', {
    payload: {
      principalId: owner.principalId,
      targetDeviceId: target,
      envelope: { id: crypto.randomUUID(), fromDeviceId: owner.config.clientId, toDeviceId: target, kind, payload },
    },
  })
  return result.delivered
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
