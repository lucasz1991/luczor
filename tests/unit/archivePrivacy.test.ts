import { describe, expect, it } from 'vitest'
import { createArchivePrivacy, hashedMutationIdentity, restoredMutationIdentity } from '@/services/runs/archivePrivacy'
import { mutationKey, type AgentCheckpoint } from '@/services/agents/chatCheckpoint'

const base: AgentCheckpoint = {
  projectId: 'project',
  sessionId: 'session',
  generation: 1,
  objective: 'Read sources',
  ephemeralDataUsed: true,
  dataPolicy: 'local_only',
  messages: [],
  completedMutations: [],
}

describe('archive privacy without evidence loss', () => {
  it('keeps analysis tags in source evidence and user text while removing private assistant thoughts', async () => {
    const source = '<analysis>Retained source section</analysis>'
    const result = await createArchivePrivacy()({
      ...base,
      messages: [
        { role: 'tool', tool_call_id: 'source-read', content: source },
        { role: 'user', content: source },
        { role: 'assistant', content: '<analysis>Private thought</analysis>Public answer' },
      ],
    })
    expect(result.messages.map(message => message.content)).toEqual([source, source, 'Public answer'])
  })
  it('preserves source fields named analysis/reasoning and filters only an assistant reasoning channel', async () => {
    const source = '{"analysis":"ordinary report","reasoning":"source rationale","chain_of_thought":"field label"}'
    const assistant = { role: 'assistant' as const, content: 'Public result', reasoning: 'PRIVATE_WORK_NOTES' }
    const result = await createArchivePrivacy()({
      ...base,
      messages: [{ role: 'tool', tool_call_id: 'source-read', content: source }, assistant],
    })
    expect(result.messages[0]!.content).toBe(source)
    expect(JSON.stringify(result.messages[1])).not.toContain('PRIVATE_WORK_NOTES')
  })
  it('redacts secrets in serialized tool evidence without changing exact numeric and escape tokens', async () => {
    const source =
      '{ "customer_id": 9007199254740993, "password": "credential", "path": "E:\\\\data", "cookie": {"value":"secret"} }'
    const result = await createArchivePrivacy()({
      ...base,
      messages: [{ role: 'tool', tool_call_id: 'source-read', content: source }],
    })
    expect(result.messages[0]!.content).toBe(
      '{ "customer_id": 9007199254740993, "password": "[REDACTED]", "path": "E:\\\\data", "cookie": "[REDACTED]" }'
    )
  })
  it('shares unchanged immutable messages and sanitized entries across growing checkpoints', async () => {
    const clean = createArchivePrivacy()
    const wire = Object.freeze({
      role: 'tool' as const,
      tool_call_id: 'exact-read',
      content: '{"exact":9007199254740993,"text":"Daten 😀","url":"file:///E:/path%20a/test.html"}',
    })
    const dirty = Object.freeze({
      role: 'tool' as const,
      tool_call_id: 'private-read',
      content: '{"authorization":"private-credential","sessionId":"live-id","text":"document evidence"}',
    })
    const first = await clean({ ...base, messages: [wire, dirty] })
    const next = await clean({ ...base, messages: [wire, dirty, { role: 'user', content: 'Continue' }] })
    expect(first.messages[0]).toBe(wire)
    expect(first.messages[1]).toBe(next.messages[1])
    expect(first.messages[1]!.content).not.toContain('private-credential')
    expect(JSON.parse(first.messages[1]!.content)).toMatchObject({ sessionId: 'live-id', text: 'document evidence' })
  })
  it('matches original argument identities only to existing durable aliases and preserves legacy keys', async () => {
    const key = mutationKey('fs_write', { content: 'password=private-value', path: 'config' })
    const alias = await hashedMutationIdentity(key)
    expect(await restoredMutationIdentity(key, [new Map([[alias, 'known-operation']])])).toBe(alias)
    expect(await restoredMutationIdentity(key, [new Set([key])])).toBe(key)
    expect(await restoredMutationIdentity(key, [new Set()])).toBe(key)
    expect(
      await restoredMutationIdentity(mutationKey('fs_write', { content: 'different', path: 'config' }), [
        new Set([alias]),
      ])
    ).not.toBe(alias)
  })
  it('retains exact nonsensitive legacy identities and hashes redacted pending-create fingerprints', async () => {
    const key = '[ "write", { "path": "exact.txt" } ]'
    const fingerprint = mutationKey('task_create', { title: 'Task', description: 'password=private-value' })
    const clean = await createArchivePrivacy()({
      ...base,
      operationIds: [[key, 'operation']],
      pendingTaskCreateVerifications: [
        { projectId: 'project', title: 'Task', externalId: 'external', state: 'unknown', fingerprint },
      ],
    })
    expect(clean.operationIds).toEqual([[key, 'operation']])
    expect(clean.pendingTaskCreateVerifications![0]!.fingerprint).toBeUndefined()
    expect(clean.pendingTaskCreateVerifications![0]!.fingerprintHash).toBe(
      (await hashedMutationIdentity(fingerprint)).slice(7)
    )
    expect(clean.pendingTaskCreateVerifications![0]!.state).toBe('unknown')
  })
})
