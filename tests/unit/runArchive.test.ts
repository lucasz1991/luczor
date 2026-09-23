import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createMemoryRunArchiveStore, createRunArchive } from '@/services/runs/runArchive'
import { createRunCoordinator } from '@/services/runs/runCoordinator'
import { createCheckpointEntrySnapshot, createCheckpointMessageSnapshot } from '@/services/agents/checkpointMessages'
import { mutationKey, type AgentCheckpoint, type ToolOutcome } from '@/services/agents/chatCheckpoint'
import type { WireMessage } from '@/services/inference/types'

const scope = { principalId: 'server/account', projectId: 'project', conversationId: 'chat', runId: 'run' }
const key = async () => 'ab'.repeat(32)
function checkpoint(): AgentCheckpoint {
  return {
    principalScopeId: scope.principalId,
    projectId: scope.projectId,
    conversationId: scope.conversationId,
    workspaceBindingId: 'workspace',
    sessionId: 'old',
    generation: 1,
    objective: 'secret objective',
    messages: [{ role: 'user', content: 'private source' }],
    completedMutations: [],
    ephemeralDataUsed: true,
    dataPolicy: 'local_only',
  }
}
const resume = { ...scope, sessionId: 'fresh', generation: 2, workspaceBindingId: 'workspace' }

describe('encrypted segmented run archive and coordinator', () => {
  it('restores exact local-only context after a new service instance, preserving Unicode and tool identities', async () => {
    const store = createMemoryRunArchiveStore()
    const write = vi.spyOn(store, 'write')
    const first = createRunArchive({ store, key })
    const value = checkpoint()
    value.messages.push(
      {
        role: 'assistant',
        content: 'x'.repeat(47_969) + '😀'.repeat(30000),
        tool_calls: [
          { id: 'call', type: 'function', function: { name: 'fs_read', arguments: '{"path":"private.ts"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call', content: 'exact result' }
    )
    await first.capture({ ...scope, messageId: 'assistant', checkpoint: value })
    // The Rust encrypted() validator consumes this same fixture. Keep the TS
    // emitted envelope keys/version aligned with the native command contract.
    const wire = JSON.parse(readFileSync(resolve('tests/fixtures/run-archive-envelope-v1.json'), 'utf8'))
    const envelopes = [
      write.mock.calls[0]![0].manifest,
      ...write.mock.calls[0]![0].segments.map(segment => segment.ciphertext),
    ]
    for (const encrypted of envelopes) {
      const envelope = JSON.parse(encrypted)
      expect(Object.keys(envelope).sort()).toEqual(Object.keys(wire).sort())
      expect(envelope.version).toBe(wire.version)
      expect(envelope.iv).toHaveLength(wire.iv.length)
    }
    expect(JSON.stringify(write.mock.calls)).not.toContain('private.ts')
    expect(JSON.stringify(write.mock.calls)).not.toContain('private source')
    const restored = await createRunCoordinator(createRunArchive({ store, key })).prepareResume(resume)
    expect(restored.status).toBe('ready')
    expect(restored.checkpoint).toEqual({ ...value, sessionId: 'fresh', generation: 2 })
    expect(restored.automaticEligible).toBe(true)
  })
  it('stores no volatile payload, derived prose, objective or operation data, while same-process continuation remains possible', async () => {
    const store = createMemoryRunArchiveStore()
    const write = vi.spyOn(store, 'write')
    const archive = createRunArchive({ store, key })
    const coordinator = createRunCoordinator(archive)
    const value = {
      ...checkpoint(),
      dataPolicy: 'ephemeral' as const,
      operationIds: [['SECRET_IDENTITY', 'uuid']] as [string, string][],
    }
    await coordinator.capture({ ...scope, messageId: 'assistant', checkpoint: value, dataPolicy: 'local_only' })
    expect(write.mock.calls[0]?.[0].segments).toEqual([])
    expect((await coordinator.prepareResume(resume)).status).toBe('ready')
    const restarted = createRunCoordinator(createRunArchive({ store, key }))
    expect(await restarted.prepareResume(resume)).toMatchObject({ status: 'needs_reread', automaticEligible: false })
    expect((await archive.load(scope))?.checkpoint).toBeUndefined()
    coordinator.clear()
    expect((await coordinator.prepareResume(resume)).status).toBe('needs_reread')
  })
  it('rejects account/chat/workspace drift, missing receipts, uncertain effects and old approvals', async () => {
    const store = createMemoryRunArchiveStore()
    const coordinator = createRunCoordinator(createRunArchive({ store, key }))
    const value = checkpoint()
    value.uncertainMutations = ['private-write']
    await coordinator.capture({ ...scope, messageId: 'assistant', checkpoint: value, state: 'waiting_approval' })
    expect(await coordinator.prepareResume(resume)).toMatchObject({
      status: 'needs_review',
      automaticEligible: false,
      reasons: ['effect_outcome_unknown', 'approval_expired'],
    })
    expect(await coordinator.prepareResume({ ...resume, review: true })).toMatchObject({
      status: 'ready',
      automaticEligible: false,
      checkpoint: { toolAccess: 'read-only' },
    })
    expect((await coordinator.prepareResume({ ...resume, workspaceBindingId: 'other', review: true })).status).toBe(
      'needs_review'
    )
    expect((await coordinator.prepareResume({ ...resume, principalId: 'other' })).status).toBe('missing')
    await expect(coordinator.prepareResume({ ...resume, conversationId: 'other' })).rejects.toThrow('scope')
  })
  it('deduplicates unchanged checkpoints, writes only new content segments and updates lifecycle without payload copies', async () => {
    const store = createMemoryRunArchiveStore()
    const write = vi.spyOn(store, 'write')
    const archive = createRunArchive({ store, key })
    const input = { ...scope, messageId: 'assistant', checkpoint: checkpoint() }
    await archive.capture(input)
    const first = write.mock.calls[0]![0].segments.length
    await archive.capture(input)
    expect(write).toHaveBeenCalledTimes(1)
    input.checkpoint.messages.push({ role: 'assistant', content: 'new' })
    await archive.capture(input)
    expect(write.mock.calls[1]![0].segments).toHaveLength(1)
    expect(first).toBeGreaterThan(1)
    await archive.setState(scope, 'completed')
    expect(write.mock.calls[2]![0].segments).toEqual([])
    expect(await createRunCoordinator(archive).listRecoverable(scope.principalId)).toEqual([])
  })
  it('fails closed on ciphertext tampering and simultaneous independent owners losing CAS', async () => {
    const store = createMemoryRunArchiveStore()
    const first = createRunArchive({ store, key })
    const second = createRunArchive({ store, key })
    const input = { ...scope, messageId: 'assistant', checkpoint: checkpoint() }
    const results = await Promise.allSettled([first.capture(input), second.capture(input)])
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const read = store.read.bind(store)
    store.read = async (...args) => {
      const result = await read(...args)
      if (result.segments[0])
        result.segments[0].ciphertext = result.segments[0].ciphertext.replace(/"data":"./u, '"data":"!')
      return result
    }
    await expect(first.load(scope)).rejects.toThrow('decryption')
  })
  it('archives 1000 growing tool rounds without rewriting prior payload segments', async () => {
    const store = createMemoryRunArchiveStore()
    const write = store.write.bind(store)
    let writes = 0,
      segments = 0,
      segmentBytes = 0,
      manifestBytes = 0
    store.write = async input => {
      writes++
      segments += input.segments.length
      segmentBytes += input.segments.reduce((sum, segment) => sum + segment.ciphertext.length, 0)
      manifestBytes += input.manifest.length
      return write(input)
    }
    const archive = createRunArchive({ store, key })
    const snapshot = createCheckpointMessageSnapshot()
    const messages: WireMessage[] = [{ role: 'user', content: 'Long task' }]
    const state = checkpoint()
    const started = performance.now()
    for (let round = 0; round < 1000; round++) {
      messages.push(
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: `c${round}`,
              type: 'function',
              function: { name: 'fs_read', arguments: JSON.stringify({ path: `file-${round}.ts` }) },
            },
          ],
        },
        { role: 'tool', tool_call_id: `c${round}`, content: `${round}:` + 'content '.repeat(125) }
      )
      await archive.capture({
        ...scope,
        messageId: 'assistant',
        checkpoint: { ...state, messages: snapshot(messages) },
      })
    }
    expect(writes).toBe(1000)
    expect(segments).toBeGreaterThanOrEqual(2000)
    expect(segments).toBeLessThan(2020)
    expect(segmentBytes).toBeLessThan(2_500_000)
    expect((await archive.load(scope))?.checkpoint?.messages).toHaveLength(2001)
    console.info(
      'RUN_ARCHIVE_1000_ROUNDS',
      JSON.stringify({
        elapsedMs: Math.round(performance.now() - started),
        writes,
        segments,
        segmentBytes,
        manifestBytes,
      })
    )
  }, 60000)

  it('reads an encrypted v1 snapshot and upgrades to v2 without losing exact operation identities', async () => {
    const store = createMemoryRunArchiveStore()
    const value = checkpoint()
    value.completedMutations = [['exact payload', { ok: true, output: { revision: 'known' } }]]
    value.operationIds = [['exact payload', 'stable-operation']]
    value.uncertainMutations = ['another exact payload']
    value.progressEvidence = { receipts: ['host-proof'], fingerprint: 'host-fingerprint' }
    const encoder = new TextEncoder()
    const cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(0xab), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ])
    const digest = async (text: string) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), byte =>
        byte.toString(16).padStart(2, '0')
      ).join('')
    const encrypt = async (id: string, text: string) => {
      const iv = new Uint8Array(12).fill(7)
      const additionalData = encoder.encode(
        `luczor-run-archive-v1:${JSON.stringify([scope.principalId, scope.projectId, scope.conversationId, scope.runId])}:${id}`
      )
      const bytes = new Uint8Array(
        await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, cryptoKey, encoder.encode(text))
      )
      return JSON.stringify({
        version: 1,
        iv: btoa(String.fromCharCode(...iv)),
        data: btoa(String.fromCharCode(...bytes)),
      })
    }
    const { messages, ...metadata } = value
    const data = [JSON.stringify(metadata), ...messages.map(message => JSON.stringify(message))]
    const ids = await Promise.all(data.map(digest))
    const manifest = {
      version: 1,
      scope,
      messageId: 'assistant',
      state: 'interrupted',
      dataPolicy: 'local_only',
      contentHash: 'legacy-v1',
      metadata: [ids[0]],
      messages: ids.slice(1).map(id => [id]),
      gaps: [],
    }
    await store.write({
      scope,
      expectedRevision: 0,
      manifest: await encrypt('manifest', JSON.stringify(manifest)),
      segments: await Promise.all(
        data.map(async (text, index) => ({ id: ids.at(index)!, ciphertext: await encrypt(ids.at(index)!, text) }))
      ),
    })
    const archive = createRunArchive({ store, key })
    expect((await archive.load(scope))?.checkpoint).toEqual(value)
    await archive.capture({ ...scope, messageId: 'assistant', checkpoint: value, state: 'interrupted' })
    expect((await createRunArchive({ store, key }).load(scope))?.checkpoint).toEqual(value)
    const writes = vi.spyOn(store, 'write')
    await archive.capture({ ...scope, messageId: 'assistant', checkpoint: value, state: 'interrupted' })
    expect(writes).not.toHaveBeenCalled()
  })

  it('archives 1000 mutation rounds with large arguments and outcomes using linear payload writes', async () => {
    const store = createMemoryRunArchiveStore()
    const commit = store.write.bind(store)
    let writes = 0,
      segments = 0,
      segmentBytes = 0,
      manifestBytes = 0
    store.write = async input => {
      writes++
      segments += input.segments.length
      segmentBytes += input.segments.reduce((sum, segment) => sum + segment.ciphertext.length, 0)
      manifestBytes += input.manifest.length
      return commit(input)
    }
    const archive = createRunArchive({ store, key })
    const snapshotMessages = createCheckpointMessageSnapshot()
    const snapshotMutations = createCheckpointEntrySnapshot<ToolOutcome>()
    const snapshotOperations = createCheckpointEntrySnapshot<string>()
    const mutations = new Map<string, ToolOutcome>()
    const operations = new Map<string, string>()
    const messages: WireMessage[] = [{ role: 'user', content: 'Large mutation task' }]
    const state = checkpoint()
    const started = performance.now()
    for (let round = 0; round < 1000; round++) {
      const args = { path: `file-${round}.ts`, content: `${round}:` + 'a'.repeat(4096) }
      const identity = mutationKey('fs_write', args)
      const outcome = { ok: true, output: { revision: round, receipt: `${round}:` + 'b'.repeat(4096) } }
      mutations.set(identity, outcome)
      operations.set(identity, `stable-operation-${round}`)
      messages.push(
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: `call-${round}`, type: 'function', function: { name: 'fs_write', arguments: JSON.stringify(args) } },
          ],
        },
        { role: 'tool', tool_call_id: `call-${round}`, content: JSON.stringify(outcome) }
      )
      await archive.capture({
        ...scope,
        messageId: 'assistant',
        checkpoint: {
          ...state,
          messages: snapshotMessages(messages),
          completedMutations: snapshotMutations(mutations),
          operationIds: snapshotOperations(operations),
        },
      })
    }
    expect(writes).toBe(1000)
    expect(segments).toBeLessThan(4030)
    expect(segmentBytes).toBeLessThan(35_000_000)
    const restored = (await createRunArchive({ store, key }).load(scope))!.checkpoint!
    expect(restored.completedMutations).toEqual([...mutations])
    expect(restored.operationIds).toEqual([...operations])
    expect(restored.messages).toEqual(messages)
    console.info(
      'RUN_ARCHIVE_1000_MUTATIONS',
      JSON.stringify({
        elapsedMs: Math.round(performance.now() - started),
        writes,
        segments,
        segmentBytes,
        manifestBytes,
        argumentCharsPerRound: 4096,
        outcomeCharsPerRound: 4096,
      })
    )
  }, 60000)
})
