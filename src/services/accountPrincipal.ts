import { invoke } from '@tauri-apps/api/core'
import { Store } from '@tauri-apps/plugin-store'
import {
  bootstrapWithApiConfig,
  getApiConfigSnapshot,
  type LuczorApiConfig,
  type LuczorApiConfigSnapshot,
} from '@/services/api/luczorApi'

const BINDING_STORE_FILE = 'luczor.account-principal.json'
const BINDING_STATE_KEY = 'bindings_v1_encrypted'
const BINDING_ADDITIONAL_DATA = 'luczor-account-principal-bindings-v1'
const MAX_CREDENTIAL_BINDINGS = 32

export type VerifiedAccountSnapshot = Readonly<{
  principalId: string
  serverOrigin: string
  serverInstance: string
  accountId: number
  config: LuczorApiConfigSnapshot
}>

type CredentialBinding = {
  credentialId: string
  serverInstance: string
  accountId: number
  principalId: string
  verifiedAt: string
}

type CredentialBindingState = {
  version: 1
  bindings: CredentialBinding[]
}

type BindingCrypto = {
  encryptionKey: CryptoKey
  credentialKey: CryptoKey
}

export class AccountPrincipalVerificationError extends Error {
  readonly verificationCause?: unknown

  constructor(message: string, verificationCause?: unknown) {
    super(message)
    this.name = 'AccountPrincipalVerificationError'
    this.verificationCause = verificationCause
  }
}

let bindingCryptoPromise: Promise<BindingCrypto> | null = null
let bindingAccess: Promise<unknown> = Promise.resolve()

function serializeBindingAccess<T>(operation: () => Promise<T>): Promise<T> {
  const next = bindingAccess.then(operation)
  bindingAccess = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function canonicalServer(baseUrl: string): { origin: string; instance: string } {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch (cause) {
    throw new AccountPrincipalVerificationError('Die konfigurierte Server-URL ist ungültig.', cause)
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new AccountPrincipalVerificationError('Die konfigurierte Server-URL ist für eine Account-ID ungeeignet.')
  }
  const origin = url.origin.toLocaleLowerCase('en-US')
  const path = url.pathname.replace(/\/+$/u, '')
  return { origin, instance: path ? `${origin}${path}` : origin }
}

async function strongSha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new AccountPrincipalVerificationError('Sichere Account-Partitionierung ist auf diesem Gerät nicht verfügbar.')
  }
  try {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return bytesToHex(new Uint8Array(digest))
  } catch (cause) {
    throw new AccountPrincipalVerificationError('Die sichere Account-ID konnte nicht berechnet werden.', cause)
  }
}

function immutableConfig(config: LuczorApiConfig): LuczorApiConfigSnapshot {
  return Object.freeze({ baseUrl: config.baseUrl, deviceKey: config.deviceKey, clientId: config.clientId })
}

function verifiedSnapshot(
  config: LuczorApiConfigSnapshot,
  serverOrigin: string,
  serverInstance: string,
  accountId: number,
  principalId: string
): VerifiedAccountSnapshot {
  return Object.freeze({ principalId, serverOrigin, serverInstance, accountId, config })
}

function validAccountId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isOfflineFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false
  const status = (error as { status?: unknown }).status
  return (
    status === 0 || status === 408 || status === 429 || (typeof status === 'number' && status >= 500 && status <= 599)
  )
}

async function bindingCrypto(): Promise<BindingCrypto> {
  bindingCryptoPromise ??= (async () => {
    const seed = await invoke<string>('memory_key_get_or_create')
    if (!/^[a-f0-9]{64}$/iu.test(seed)) throw new Error('Invalid OS account-binding encryption key.')
    const seedBytes = hexToBytes(seed)
    const encryptionMaterial = await deriveKeyMaterial(seedBytes, 'luczor-account-binding-encryption-v1')
    const credentialMaterial = await deriveKeyMaterial(seedBytes, 'luczor-account-binding-credential-v1')
    const [encryptionKey, credentialKey] = await Promise.all([
      globalThis.crypto.subtle.importKey('raw', encryptionMaterial, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
      globalThis.crypto.subtle.importKey('raw', credentialMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    ])
    return { encryptionKey, credentialKey }
  })()
  return bindingCryptoPromise
}

async function deriveKeyMaterial(seed: Uint8Array, purpose: string): Promise<Uint8Array<ArrayBuffer>> {
  const purposeBytes = new TextEncoder().encode(purpose)
  const input = new Uint8Array(seed.length + purposeBytes.length)
  input.set(seed)
  input.set(purposeBytes, seed.length)
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input))
}

async function credentialIdentity(serverInstance: string, deviceKey: string): Promise<string> {
  const { credentialKey } = await bindingCrypto()
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    credentialKey,
    new TextEncoder().encode(`${serverInstance}\u0000${deviceKey}`)
  )
  return `credential:v1:${bytesToHex(new Uint8Array(signature))}`
}

async function loadBindingState(): Promise<CredentialBindingState> {
  const store = await Store.load(BINDING_STORE_FILE)
  const encrypted = await store.get<string>(BINDING_STATE_KEY)
  if (!encrypted) return { version: 1, bindings: [] }
  try {
    const envelope = JSON.parse(encrypted) as {
      version?: number
      algorithm?: string
      iv?: string
      ciphertext?: string
    }
    if (
      envelope.version !== 1 ||
      envelope.algorithm !== 'AES-256-GCM' ||
      typeof envelope.iv !== 'string' ||
      typeof envelope.ciphertext !== 'string'
    ) {
      throw new Error('Unsupported account-binding envelope.')
    }
    const { encryptionKey } = await bindingCrypto()
    const plaintext = await globalThis.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(envelope.iv),
        additionalData: new TextEncoder().encode(BINDING_ADDITIONAL_DATA),
      },
      encryptionKey,
      base64ToBytes(envelope.ciphertext)
    )
    const state = JSON.parse(new TextDecoder().decode(plaintext)) as CredentialBindingState
    if (state.version !== 1 || !Array.isArray(state.bindings) || !state.bindings.every(validBinding)) {
      throw new Error('Invalid encrypted account-binding state.')
    }
    return state
  } catch (cause) {
    throw new AccountPrincipalVerificationError(
      'Die geschützte Account-Zuordnung ist beschädigt oder wurde manipuliert.',
      cause
    )
  }
}

function validBinding(binding: CredentialBinding): boolean {
  return (
    !!binding &&
    typeof binding.credentialId === 'string' &&
    /^credential:v1:[a-f0-9]{64}$/u.test(binding.credentialId) &&
    typeof binding.serverInstance === 'string' &&
    validAccountId(binding.accountId) &&
    /^account:v2:[a-f0-9]{64}$/u.test(binding.principalId) &&
    typeof binding.verifiedAt === 'string' &&
    Number.isFinite(Date.parse(binding.verifiedAt))
  )
}

async function saveBindingState(state: CredentialBindingState): Promise<void> {
  const { encryptionKey } = await bindingCrypto()
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(state))
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(BINDING_ADDITIONAL_DATA),
    },
    encryptionKey,
    plaintext
  )
  const store = await Store.load(BINDING_STORE_FILE)
  await store.set(
    BINDING_STATE_KEY,
    JSON.stringify({
      version: 1,
      algorithm: 'AES-256-GCM',
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    })
  )
  await store.save()
}

async function recordLiveBinding(binding: CredentialBinding): Promise<void> {
  await serializeBindingAccess(async () => {
    const state = await loadBindingState()
    const existing = state.bindings.find(item => item.credentialId === binding.credentialId)
    if (
      existing &&
      (existing.serverInstance !== binding.serverInstance ||
        existing.accountId !== binding.accountId ||
        existing.principalId !== binding.principalId)
    ) {
      throw new AccountPrincipalVerificationError(
        'Der Device-Key widerspricht seiner zuvor verifizierten Account-Zuordnung.'
      )
    }
    state.bindings = [binding, ...state.bindings.filter(item => item.credentialId !== binding.credentialId)].slice(
      0,
      MAX_CREDENTIAL_BINDINGS
    )
    await saveBindingState(state)
  })
}

async function resolveOfflineBinding(credentialId: string, serverInstance: string): Promise<CredentialBinding> {
  return serializeBindingAccess(async () => {
    const state = await loadBindingState()
    const binding = state.bindings.find(item => item.credentialId === credentialId)
    if (!binding) {
      throw new AccountPrincipalVerificationError(
        'Dieser Device-Key wurde noch nicht live einem Account zugeordnet; Offline-Zugriff wird verweigert.'
      )
    }
    if (binding.serverInstance !== serverInstance) {
      throw new AccountPrincipalVerificationError('Die gespeicherte Account-Zuordnung passt nicht zum Server.')
    }
    const expectedPrincipal = `account:v2:${await strongSha256(`${serverInstance}\u0000${binding.accountId}`)}`
    if (binding.principalId !== expectedPrincipal) {
      throw new AccountPrincipalVerificationError('Die gespeicherte Account-ID ist widersprüchlich.')
    }
    return binding
  })
}

/**
 * Resolve the authenticated server account without trusting a user-entered
 * identifier. A successful live bootstrap creates an AES-GCM-protected
 * credential binding backed by an OS-keychain secret. A known credential can
 * then resolve offline; a new, rejected or contradictory credential fails
 * closed. `null` exclusively means that no Device Key is configured.
 */
export async function getVerifiedAccountSnapshot(): Promise<VerifiedAccountSnapshot | null> {
  const config = immutableConfig(await getApiConfigSnapshot())
  if (!config.deviceKey) return null

  const server = canonicalServer(config.baseUrl)
  const credentialId = await credentialIdentity(server.instance, config.deviceKey)
  try {
    const bootstrap = await bootstrapWithApiConfig(config)
    const accountId = bootstrap.user?.id
    if (!validAccountId(accountId)) {
      throw new AccountPrincipalVerificationError('Der Server hat keine gültige authentifizierte Account-ID geliefert.')
    }
    const principalId = `account:v2:${await strongSha256(`${server.instance}\u0000${accountId}`)}`
    await recordLiveBinding({
      credentialId,
      serverInstance: server.instance,
      accountId,
      principalId,
      verifiedAt: new Date().toISOString(),
    })
    return verifiedSnapshot(config, server.origin, server.instance, accountId, principalId)
  } catch (cause) {
    if (cause instanceof AccountPrincipalVerificationError) throw cause
    if (!isOfflineFailure(cause)) {
      throw new AccountPrincipalVerificationError(
        'Der konfigurierte Account konnte nicht sicher beim Server verifiziert werden.',
        cause
      )
    }
    const binding = await resolveOfflineBinding(credentialId, server.instance)
    return verifiedSnapshot(config, server.origin, server.instance, binding.accountId, binding.principalId)
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], pair => Number.parseInt(pair, 16))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return globalThis.btoa(binary)
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = globalThis.atob(value)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
