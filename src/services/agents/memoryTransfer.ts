import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { luczorMemory, planMemoryWrite, type MemoryRecord, type RememberInput } from '@/services/memory/luczorMemory'
import { redactAbsoluteFilesystemPaths } from '@/services/prompt/promptContextAssembler'

export type AgentMemorySource = 'chatgpt' | 'codex' | 'agent'
export type AgentMemoryPreview = Readonly<{
  id: string
  title: string
  content: string
  source: AgentMemorySource
  sourceRef?: string
  messageCount: number
  truncated: boolean
}>

export type ParseAgentMemoryInput = Readonly<{
  text: string
  format: 'chatgpt-json' | 'markdown'
  source: AgentMemorySource
  sourceRef?: string
}>

export type ImportAgentMemoryInput = Readonly<{
  projectId: string
  /** The UI's selected workspace principal; device identities map to local memory only. */
  principalId?: string
  content: string
  source: AgentMemorySource
  sourceRef?: string
  visibility?: 'private' | 'syncable'
}>

type MemoryTransferDependencies = Readonly<{
  getAccount: () => Promise<{ principalId: string } | null>
  remember: (input: RememberInput) => Promise<MemoryRecord>
}>

export const MAX_AGENT_MEMORY_CHARACTERS = 32_000
export const MAX_AGENT_MEMORY_FILE_BYTES = 16 * 1024 * 1024
const MAX_CONVERSATIONS = 100
const MAX_NODES = 20_000
const MAX_BRANCH_NODES = 1_000
const MAX_MESSAGES = 200

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function validReference(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
}

function requireSourceReference(value: unknown): void {
  if (value === undefined) return
  if (!validReference(value)) throw new Error('Die Quellenreferenz ist ungültig.')
  if (/^(?:[a-z]:[\\/]|[\\/]|~[\\/]|file:)/iu.test(value) || redactAbsoluteFilesystemPaths(value) !== value) {
    throw new Error('Als Quellenreferenz bitte eine Aufgaben-ID oder Webadresse verwenden, keinen lokalen Dateipfad.')
  }
}

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
}

function requireSource(source: unknown): asserts source is AgentMemorySource {
  if (source !== 'chatgpt' && source !== 'codex' && source !== 'agent') {
    throw new Error('Die Quelle für den Erinnerungsimport ist ungültig.')
  }
}

function visibleMessage(node: Record<string, unknown>): { content: string; truncated: boolean } | undefined {
  const message = object(node.message)
  const author = object(message?.author)
  const role = author?.role
  if (!message || (role !== 'user' && role !== 'assistant')) return undefined
  if (message.channel !== undefined && message.channel !== null && message.channel !== 'final') return undefined
  if (message.recipient !== undefined && message.recipient !== null && message.recipient !== 'all') return undefined
  const metadata = object(message.metadata)
  if (metadata?.is_visually_hidden_from_conversation === true || metadata?.is_user_system_message === true) {
    return undefined
  }
  const content = object(message.content)
  if (!content || (content.content_type !== 'text' && content.content_type !== 'multimodal_text')) return undefined
  if (!Array.isArray(content.parts)) return undefined
  // Text strings are displayed conversation content. Attachments, tool payloads,
  // reasoning objects and every other nested field are deliberately ignored.
  const parts: string[] = []
  let length = 0
  let truncated = false
  for (const part of content.parts.slice(0, 100)) {
    if (typeof part !== 'string') continue
    const text = cleanText(part)
    if (!text) continue
    const remaining = MAX_AGENT_MEMORY_CHARACTERS - length
    if (remaining <= 0) {
      truncated = true
      break
    }
    parts.push(text.slice(0, remaining))
    length += Math.min(text.length, remaining) + 2
    truncated ||= text.length > remaining
  }
  if (!parts.length) return undefined
  const label = role === 'user' ? 'Nutzer' : 'Assistent'
  return { content: `${label}:\n${parts.join('\n\n')}`, truncated: truncated || content.parts.length > 100 }
}

function conversationPreview(
  value: unknown,
  index: number,
  input: ParseAgentMemoryInput,
  omittedConversations: boolean
): AgentMemoryPreview | undefined {
  const conversation = object(value)
  const mapping = object(conversation?.mapping)
  if (!conversation || !mapping || !validReference(conversation.current_node)) return undefined
  const entries = Object.entries(mapping)
  if (entries.length > MAX_NODES) throw new Error('Ein Chat ist für den Import zu groß. Bitte einen Auszug verwenden.')
  const nodes = new Map(entries)
  const visited = new Set<string>()
  const selected: string[] = []
  let current: string | undefined = conversation.current_node
  let length = 0
  let truncated = omittedConversations
  while (current) {
    if (visited.has(current)) throw new Error('Der Chat-Export enthält einen ungültigen Gesprächsverlauf.')
    if (visited.size >= MAX_BRANCH_NODES || selected.length >= MAX_MESSAGES) {
      truncated = true
      break
    }
    visited.add(current)
    const node = object(nodes.get(current))
    if (!node) throw new Error('Der aktive Gesprächsverlauf im Chat-Export ist unvollständig.')
    const visible = visibleMessage(node)
    if (visible) {
      const remaining = MAX_AGENT_MEMORY_CHARACTERS - length
      if (remaining <= 0) {
        truncated = true
        break
      }
      selected.push(visible.content.slice(0, remaining))
      length += Math.min(visible.content.length, remaining) + 2
      truncated ||= visible.truncated || visible.content.length > remaining
    }
    if (node.parent !== null && node.parent !== undefined && !validReference(node.parent)) {
      throw new Error('Der Chat-Export enthält eine ungültige Verknüpfung.')
    }
    current = typeof node.parent === 'string' ? node.parent : undefined
  }
  if (!selected.length) return undefined
  const sourceRef = validReference(conversation.conversation_id)
    ? conversation.conversation_id
    : validReference(conversation.id)
      ? conversation.id
      : input.sourceRef
  requireSourceReference(sourceRef)
  return Object.freeze({
    id: `${input.source}-${index}`,
    title: typeof conversation.title === 'string' ? cleanText(conversation.title).slice(0, 160) : `Chat ${index + 1}`,
    content: selected.reverse().join('\n\n').slice(0, MAX_AGENT_MEMORY_CHARACTERS),
    source: input.source,
    sourceRef,
    messageCount: selected.length,
    truncated,
  })
}

/**
 * Read an explicitly selected export into an editable preview. JSON only uses
 * the current branch's visible user/assistant messages; never flatten a dump.
 * This function writes no memory and performs no external calls.
 */
export function parseAgentMemorySource(input: ParseAgentMemoryInput): readonly AgentMemoryPreview[] {
  requireSource(input.source)
  requireSourceReference(input.sourceRef)
  if (typeof input.text !== 'string' || !input.text.trim())
    throw new Error('Die ausgewählte Datei enthält keinen Text.')
  if (new TextEncoder().encode(input.text).byteLength > MAX_AGENT_MEMORY_FILE_BYTES) {
    throw new Error('Der Export darf höchstens 16 MiB groß sein. Bitte einen kleineren Auszug auswählen.')
  }
  if (input.format === 'markdown') {
    const content = cleanText(input.text)
    if (!content) throw new Error('Die ausgewählte Datei enthält keinen lesbaren Text.')
    return Object.freeze([
      Object.freeze({
        id: `${input.source}-text`,
        title:
          input.source === 'codex'
            ? 'Codex-Ergebnis'
            : input.source === 'agent'
              ? 'Agenten-Ergebnis'
              : 'ChatGPT-Auszug',
        content: content.slice(0, MAX_AGENT_MEMORY_CHARACTERS),
        source: input.source,
        sourceRef: input.sourceRef,
        messageCount: 1,
        truncated: content.length > MAX_AGENT_MEMORY_CHARACTERS,
      }),
    ])
  }
  if (input.format !== 'chatgpt-json' || input.source !== 'chatgpt') throw new Error('Das Importformat ist ungültig.')
  let parsed: unknown
  try {
    parsed = JSON.parse(input.text)
  } catch {
    throw new Error('Die ausgewählte Datei ist kein gültiger ChatGPT-JSON-Export.')
  }
  const root = object(parsed)
  const conversations = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root?.conversations)
      ? root.conversations
      : [parsed]
  const omitted = conversations.length > MAX_CONVERSATIONS
  const previews = conversations
    .slice(0, MAX_CONVERSATIONS)
    .map((conversation, index) => conversationPreview(conversation, index, input, omitted))
    .filter((preview): preview is AgentMemoryPreview => preview !== undefined)
  if (!previews.length) {
    throw new Error(
      'Im Export wurde kein aktiver Gesprächsverlauf mit sichtbaren Nutzer- oder Assistententexten gefunden.'
    )
  }
  return Object.freeze(previews)
}

/** Called only by the user's final import action after reviewing and editing the selected text. */
export async function importAgentMemory(
  input: ImportAgentMemoryInput,
  dependencies: MemoryTransferDependencies = {
    getAccount: getVerifiedAccountSnapshot,
    remember: value => luczorMemory.remember(value),
  }
): Promise<MemoryRecord> {
  requireSource(input.source)
  if (!validReference(input.projectId)) throw new Error('Für den Import muss ein Projekt ausgewählt sein.')
  requireSourceReference(input.sourceRef)
  if (input.visibility !== undefined && input.visibility !== 'private' && input.visibility !== 'syncable') {
    throw new Error('Die Sichtbarkeit für den Erinnerungsimport ist ungültig.')
  }
  if (typeof input.content !== 'string') throw new Error('Der ausgewählte Erinnerungstext ist ungültig.')
  const content = cleanText(input.content)
  if (!content || content.length > MAX_AGENT_MEMORY_CHARACTERS) {
    throw new Error(`Bitte zwischen 1 und ${MAX_AGENT_MEMORY_CHARACTERS} Zeichen als Erinnerung auswählen.`)
  }
  // Snapshot all selected fields before any await, even when called from a reactive form.
  const selected = Object.freeze({ ...input, content, visibility: input.visibility ?? 'private' })
  const account = await dependencies.getAccount()
  const memoryPrincipalId = account?.principalId ?? 'device-local'
  const localWorkspace =
    selected.principalId === 'device-local' || /^device:v1:[a-f0-9]{64}$/u.test(selected.principalId ?? '')
  if (selected.principalId && selected.principalId !== memoryPrincipalId && !(localWorkspace && !account)) {
    throw new Error('Das ausgewählte Konto hat sich geändert. Bitte den Import im aktuellen Projekt erneut prüfen.')
  }
  const normalized = content.replace(/\s+/gu, ' ')
  const sourceIdentity = JSON.stringify([selected.source, selected.sourceRef ?? '', normalized])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceIdentity))
  const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  const request: RememberInput = {
    content,
    projectId: selected.projectId,
    scope: 'project',
    source: `${selected.source}_import`,
    sourceRef: selected.sourceRef,
    featureKey: `agent-import:${key}`,
    writeIntent: 'confirmed',
    retention: 'durable',
    visibility: selected.visibility,
    type: 'note',
    tags: ['agent-import', selected.source],
    provenance: { import_version: 1, user_reviewed: true, import_source: selected.source },
    expectedPrincipalId: memoryPrincipalId,
  }
  if (planMemoryWrite(request).sensitivity === 'secret') {
    throw new Error(
      'Der ausgewählte Text enthält mögliche Zugangsdaten oder sensible Werte. Bitte vor dem dauerhaften Import entfernen.'
    )
  }
  return dependencies.remember(request)
}
