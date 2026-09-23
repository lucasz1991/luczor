import { describe, expect, it } from 'vitest'
import { createRunArchive, createMemoryRunArchiveStore } from '@/services/runs/runArchive'
import { createRunCoordinator } from '@/services/runs/runCoordinator'
import { createChatEffectJournal, type EffectRecord } from '@/services/chatEffectJournal'
import { mutationKey, type AgentCheckpoint } from '@/services/agents/chatCheckpoint'

describe('write-ahead crash boundaries', () => {
  it.each(['before_receipt', 'after_started', 'after_effect', 'after_receipt', 'after_checkpoint'] as const)(
    'never replays a mutation after a crash at %s',
    async boundary => {
      const scope = { principalId: 'account', projectId: 'project', conversationId: 'chat', runId: 'run' }
      const store = createMemoryRunArchiveStore()
      const key = async () => 'ab'.repeat(32)
      const archive = createRunArchive({ store, key })
      const effects = new Map<string, EffectRecord>()
      const effectStore = {
        read: async (_principal: string, id: string) => effects.get(id) ?? null,
        write: async (record: EffectRecord, revision: number) => {
          if ((effects.get(record.runId)?.revision ?? 0) !== revision) throw new Error('revision')
          const next = { ...record, revision: revision + 1 }
          effects.set(record.runId, next)
          return next
        },
      }
      const args = { path: 'local-file', content: 'private contents' }
      const identity = mutationKey('fs_write', args)
      const call = { id: 'provider-call', name: 'fs_write', arguments: args, operationId: 'stable-operation' }
      const checkpoint: AgentCheckpoint = {
        principalScopeId: scope.principalId,
        projectId: scope.projectId,
        conversationId: scope.conversationId,
        sessionId: 'old',
        generation: 1,
        objective: 'write file',
        messages: [
          { role: 'user', content: 'Write file' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(args) } },
            ],
          },
        ],
        dataPolicy: 'local_only',
        ephemeralDataUsed: true,
        completedMutations: [],
        uncertainMutations: [identity],
        operationIds: [[identity, call.operationId]],
      }
      // This commit is awaited before the effect journal can admit the write.
      await archive.capture({ ...scope, messageId: 'assistant', checkpoint })
      let performedEffects = 0
      if (boundary !== 'before_receipt') {
        const receipt = await createChatEffectJournal(scope, effectStore).before(call)
        if (boundary !== 'after_started') performedEffects++
        if (boundary === 'after_receipt' || boundary === 'after_checkpoint') await receipt.finish(true)
      }
      if (boundary === 'after_checkpoint') {
        checkpoint.uncertainMutations = []
        checkpoint.completedMutations = [[identity, { ok: true, output: 'written' }]]
        checkpoint.messages.push({ role: 'tool', tool_call_id: call.id, content: '{"ok":true}' })
        await archive.capture({ ...scope, messageId: 'assistant', checkpoint })
      }
      // A genuinely fresh coordinator has neither volatile context nor approvals.
      const restarted = createRunCoordinator(createRunArchive({ store, key }))
      const prepared = await restarted.prepareResume({ ...scope, sessionId: 'new', generation: 2 })
      expect(prepared.status).toBe(boundary === 'after_checkpoint' ? 'ready' : 'needs_review')
      expect(prepared.automaticEligible).toBe(boundary === 'after_checkpoint')
      const replay =
        boundary === 'before_receipt'
          ? undefined
          : await createChatEffectJournal({ ...scope, runId: 'new-run' }, effectStore)
              .before({ ...call, id: 'new-provider-call' })
              .catch(error => error as Error)
      const replayRejected = replay instanceof Error && replay.message.includes('nicht blind wiederholen')
      expect(replayRejected).toBe(boundary !== 'before_receipt')
      expect(performedEffects).toBe(['after_effect', 'after_receipt', 'after_checkpoint'].includes(boundary) ? 1 : 0)
    }
  )
})
