import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import { redactProviderSecrets } from '@/services/prompt/promptContextAssembler'
import { sanitizeJsonText } from '@/services/prompt/structuredText'
import { publicAnswerText } from '@/services/publicAnswerStream'

const REDACTED = '[REDACTED]'
const privateField =
  /^(?:.*password|passwd|pwd|.*secret|secretkey|devicekey|.*apikey|authorization|proxyauthorization|cookie|setcookie|token|accesstoken|refreshtoken|authtoken|idtoken|sessiontoken|privatekey)$/iu
const reasoningField = /^(?:reasoning|reasoning_content|analysis|chain_of_thought)$/iu
const hashPattern = /^sha256:[a-f0-9]{64}$/u
const isPrivateField = (key: string) => privateField.test(key.replace(/[^a-z0-9]/giu, ''))

/** Same prefix as existing durable task-create fingerprints; legacy raw keys remain valid. */
export async function hashedMutationIdentity(identity: string): Promise<string> {
  if (hashPattern.test(identity)) return identity
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))
  return `sha256:${Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

/** Only select an existing exact hash alias, never infer a successful effect. */
export async function restoredMutationIdentity(
  identity: string,
  collections: readonly { has(key: string): boolean }[]
): Promise<string> {
  if (collections.some(collection => collection.has(identity))) return identity
  const hashed = await hashedMutationIdentity(identity)
  return collections.some(collection => collection.has(hashed)) ? hashed : identity
}

/** Per-run caches preserve frozen checkpoint entry identity and linear payload processing. */
export function createArchivePrivacy() {
  const objects = new WeakMap<object, unknown>()
  const entries = new WeakMap<object, Promise<unknown>>()
  const strings = new Map<string, string>()
  const identities = new Map<string, Promise<string>>()

  function text(value: string): string {
    const cached = strings.get(value)
    if (cached !== undefined) return cached
    // Token replacement preserves source formatting, escape syntax and large numeric literals.
    if (/^[\s]*[\[{]/u.test(value)) {
      const result = sanitizeJsonText(value, text, isPrivateField)
      if (result !== undefined) {
        strings.set(value, result)
        return result
      }
    }
    let privateHeader = false
    const result = redactProviderSecrets(value)
      .split(/(\r?\n)/u)
      .map(line => {
        if (/^\r?\n$/u.test(line)) return line
        if (privateHeader && /^[\t ]/u.test(line)) return REDACTED
        privateHeader = /\b((?:proxy-)?authorization|(?:set-)?cookie)[\t ]*:/iu.test(line)
        return privateHeader
          ? line.replace(/\b((?:proxy-)?authorization|(?:set-)?cookie)[\t ]*:[^\r\n]*/giu, '$1: [REDACTED]')
          : line
      })
      .join('')
    strings.set(value, result)
    return result
  }

  function argumentsFor(name: unknown, value: unknown): unknown {
    const field = name === 'browser_fill' ? 'value' : name === 'os_type_text' ? 'text' : undefined
    if (!field) return sanitize(value)
    // An input target can be a password field without saying so in the model arguments.
    if (typeof value === 'string') {
      return sanitizeJsonText(value, text, key => key === field || isPrivateField(key)) ?? REDACTED
    }
    const clean = sanitize(value)
    if (clean && typeof clean === 'object' && !Array.isArray(clean) && field in clean)
      return { ...clean, [field]: REDACTED }
    return clean
  }

  function sanitize<T>(value: T): T {
    if (typeof value === 'string') return text(value) as T
    if (!value || typeof value !== 'object') return value
    if (Object.isFrozen(value) && objects.has(value)) return objects.get(value) as T
    let result: unknown
    if (Array.isArray(value)) {
      const items = value.map(item => sanitize(item))
      result = items.every((item, index) => item === value.at(index)) ? value : items
    } else {
      const record = value as Record<string, unknown>
      const originals = Object.entries(record)
      const fields = originals.map(
        ([name, item]) =>
          [
            name,
            isPrivateField(name) || (record.role === 'assistant' && reasoningField.test(name))
              ? REDACTED
              : name === 'arguments'
                ? argumentsFor(record.name, item)
                : name === 'content' && record.role === 'assistant' && typeof item === 'string'
                  ? text(publicAnswerText(item, true))
                  : sanitize(item),
          ] as const
      )
      result = fields.every(([, item], index) => item === originals.at(index)![1]) ? value : Object.fromEntries(fields)
    }
    if (Object.isFrozen(value)) {
      if (result !== value) Object.freeze(result)
      objects.set(value, result)
    }
    return result as T
  }

  function identity(value: string): Promise<string> {
    let pending = identities.get(value)
    if (!pending) {
      let clean: unknown = text(value)
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed) && parsed.length === 2) {
          const argumentsValue = argumentsFor(parsed[0], parsed[1])
          if (argumentsValue !== parsed[1]) clean = JSON.stringify([parsed[0], argumentsValue])
        }
      } catch {
        /* Legacy opaque identities retain their exact value. */
      }
      pending = clean === value ? Promise.resolve(value) : hashedMutationIdentity(value)
      identities.set(value, pending)
    }
    return pending
  }

  async function entry(value: readonly unknown[]): Promise<unknown> {
    if (Object.isFrozen(value) && entries.has(value)) return entries.get(value)!
    const pending = (async () => {
      const cleaned = sanitize(value)
      const first = typeof value[0] === 'string' ? await identity(value[0]) : cleaned[0]
      if (cleaned === value && first === value[0]) return value
      const result = [first, ...cleaned.slice(1)]
      return Object.isFrozen(value) ? Object.freeze(result) : result
    })()
    if (Object.isFrozen(value)) entries.set(value, pending)
    return pending
  }

  return async (checkpoint: AgentCheckpoint): Promise<AgentCheckpoint> => {
    const { completedMutations, operationIds, uncertainMutations, ...rest } = checkpoint
    const cleaned = sanitize(rest)
    // Fingerprints participate in exact-match recovery too; never replace them with a redaction marker.
    const verifications = async (values: NonNullable<AgentCheckpoint['pendingTaskCreateVerifications']>) =>
      Promise.all(
        values.map(async value => {
          const result = sanitize(value)
          if (!value.fingerprint || result.fingerprint === value.fingerprint) return result
          const { fingerprint: omitted, ...safe } = result
          void omitted
          return { ...safe, fingerprintHash: (await hashedMutationIdentity(value.fingerprint)).slice(7) }
        })
      )
    return {
      ...cleaned,
      ...(checkpoint.pendingTaskCreateVerifications
        ? { pendingTaskCreateVerifications: await verifications(checkpoint.pendingTaskCreateVerifications) }
        : {}),
      ...(checkpoint.resolvedTaskCreateVerifications
        ? { resolvedTaskCreateVerifications: await verifications(checkpoint.resolvedTaskCreateVerifications) }
        : {}),
      completedMutations: (await Promise.all(
        completedMutations.map(value => entry(value))
      )) as AgentCheckpoint['completedMutations'],
      ...(operationIds
        ? {
            operationIds: (await Promise.all(
              operationIds.map(value => entry(value))
            )) as AgentCheckpoint['operationIds'],
          }
        : {}),
      ...(uncertainMutations ? { uncertainMutations: await Promise.all(uncertainMutations.map(identity)) } : {}),
    }
  }
}
