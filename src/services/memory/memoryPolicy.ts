import type { MemoryRecord } from './luczorMemory'
import { memoryMetadataOf } from './memoryMetadata'

export type MemoryReuse = 'conversation' | 'project' | 'user'
/** Reuse never changes storage consent, source authority or truth classification. */
export function memoryReuse(record: MemoryRecord): MemoryReuse {
  const explicit = record.provenance?.reuse_scope
  if (explicit === 'conversation' || explicit === 'project' || explicit === 'user') return explicit
  if (record.status === 'candidate') return 'conversation'
  return record.scope === 'user' ? 'user' : 'project'
}

export function canReuseMemory(
  record: MemoryRecord,
  context: { conversationId?: string; allowProjectHints?: boolean }
): boolean {
  if (
    record.status === 'superseded' ||
    record.sensitivity !== 'normal' ||
    (record.expiresAt && record.expiresAt <= Date.now())
  )
    return false
  const sameConversation =
    !!context.conversationId &&
    memoryMetadataOf(record)?.evidence.sources.some(
      source => source.kind === 'chat' && source.conversationId === context.conversationId
    )
  if (memoryReuse(record) === 'conversation') return sameConversation === true
  if (record.status === 'active') return true
  return (
    record.status === 'candidate' &&
    record.source === 'user' &&
    context.allowProjectHints === true &&
    memoryReuse(record) === 'project'
  )
}

export function memoryCanPrepareProjectContext(record: MemoryRecord): boolean {
  return memoryReuse(record) !== 'conversation' && canReuseMemory(record, { allowProjectHints: true })
}

export type CaptureSpan = {
  start: number
  end: number
  status: 'stored' | 'deferred' | 'excluded'
  reason?: string
  recordId?: string
}
export type CaptureDescriptor = {
  expectedPrincipalId: string
  projectId: string
  conversationId: string
  messageId: string
  segmentId?: string
  sourceLength: number
  spans: CaptureSpan[]
}
export type CaptureCoverage = Omit<CaptureDescriptor, 'expectedPrincipalId'> & {
  principalId: string
  updatedAt: number
}
