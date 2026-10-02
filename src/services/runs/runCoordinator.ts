import { unresolvedCheckpointCalls } from '@/services/agents/continuationHistory'
import {
  createRunArchive,
  type ArchivedRun,
  type ArchivedRunState,
  type RunArchive,
  type RunArchiveScope,
} from './runArchive'
import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import type { ArchivedHistorySource } from '@/services/inference/focusedTools'
import type { WireMessage } from '@/services/inference/types'

export type ResumePreparation = {
  status: 'ready' | 'needs_review' | 'needs_reread' | 'missing'
  reasons: string[]
  automaticEligible: boolean
  checkpoint?: AgentCheckpoint
  archived?: ArchivedRun
}
/** Owns durable working context independently of components and process-local maps.
 * Preparation grants no execution capability: the caller registers a fresh scope,
 * applies the current tool mode and obtains any new side-effect approval as usual.
 */
export function createRunCoordinator(archive: RunArchive = createRunArchive()) {
  const volatile = new Map<string, { checkpoint: AgentCheckpoint; archived: ArchivedRun }>()
  const key = (scope: RunArchiveScope) =>
    JSON.stringify([scope.principalId, scope.projectId, scope.conversationId, scope.runId])
  return {
    /** Metadata is cached only within this captured request scope, never in model context. */
    historySource(input: RunArchiveScope, assertCurrent: () => void | Promise<void>): ArchivedHistorySource {
      const scope = Object.freeze({ ...input })
      let cached: { expiresAt: number; runs: ArchivedRun[] } | undefined
      // One selected archive per active reader, so paged reads do not repeatedly
      // decrypt the complete run. A changed revision invalidates this snapshot.
      let loaded: { runId: string; revision: number; messages: readonly WireMessage[] } | undefined
      const records = async () => {
        await assertCurrent()
        if (!cached || cached.expiresAt <= Date.now()) {
          const runs = await archive.list(scope.principalId, {
            projectId: scope.projectId,
            conversationId: scope.conversationId,
          })
          await assertCurrent()
          cached = {
            expiresAt: Date.now() + 5000,
            runs: runs
              .filter(
                run =>
                  run.state === 'completed' &&
                  run.scope.principalId === scope.principalId &&
                  run.scope.projectId === scope.projectId &&
                  run.scope.conversationId === scope.conversationId &&
                  run.scope.runId !== scope.runId
              )
              .sort(
                (left, right) => right.updatedAt - left.updatedAt || left.scope.runId.localeCompare(right.scope.runId)
              ),
          }
        }
        return cached.runs
      }
      return {
        async list() {
          const runs = await records()
          await assertCurrent()
          return runs.map(run => ({
            runId: run.scope.runId,
            updatedAt: run.updatedAt,
            messageId: run.messageId,
            available: !run.gaps.length,
          }))
        },
        async messages(runId) {
          const runs = await records()
          const selected = runs.find(run => run.scope.runId === runId)
          if (!selected) throw new Error('archive_not_available')
          if (selected.gaps.length) throw new Error('archive_content_not_retained')
          if (loaded?.runId === runId && loaded.revision === selected.revision) {
            await assertCurrent()
            return loaded.messages
          }
          const requested = { ...scope, runId }
          const saved = await archive.load(requested)
          await assertCurrent()
          if (!saved || saved.state !== 'completed' || key(saved.scope) !== key(requested))
            throw new Error('archive_not_available')
          if (saved.gaps.length || !saved.checkpoint) throw new Error('archive_content_not_retained')
          // Historical evidence only: never return resume metadata, approvals or effect authority.
          loaded = { runId, revision: saved.revision, messages: saved.checkpoint.messages }
          return loaded.messages
        },
      }
    },
    async capture(input: Parameters<RunArchive['capture']>[0]) {
      const archived = await archive.capture(input)
      if (archived.state === 'completed' || archived.state === 'cancelled') volatile.delete(key(input))
      else volatile.set(key(input), { checkpoint: input.checkpoint, archived })
      return archived
    },
    async setState(scope: RunArchiveScope, state: ArchivedRunState) {
      await archive.setState(scope, state)
      const cached = volatile.get(key(scope))
      if (cached) cached.archived = { ...cached.archived, state }
      if (state === 'completed' || state === 'cancelled') volatile.delete(key(scope))
    },
    forget(scope: RunArchiveScope) {
      volatile.delete(key(scope))
      archive.clearCaches(scope)
    },
    clear(principalId?: string) {
      archive.clearCaches()
      for (const [id, cached] of volatile)
        if (!principalId || cached.archived.scope.principalId === principalId) volatile.delete(id)
    },
    listRecoverable: async (principalId: string) =>
      (await archive.list(principalId)).filter(run => run.state !== 'completed' && run.state !== 'cancelled'),
    async prepareResume(
      input: RunArchiveScope & {
        sessionId: string
        generation: number
        workspaceBindingId?: string
        toolAccess?: 'read-only' | 'none'
        review?: boolean
      }
    ): Promise<ResumePreparation> {
      const cached = volatile.get(key(input))
      const archived = cached
        ? { ...cached.archived, checkpoint: cached.checkpoint, gaps: [] }
        : await archive.load(input)
      if (!archived) return { status: 'missing', reasons: ['archive_missing'], automaticEligible: false }
      if (archived.gaps.length || !archived.checkpoint)
        return {
          status: 'needs_reread',
          reasons: ['ephemeral_context_not_retained'],
          automaticEligible: false,
          archived,
        }
      const checkpoint = archived.checkpoint
      const reasons: string[] = []
      if (checkpoint.workspaceBindingId !== input.workspaceBindingId) reasons.push('workspace_binding_changed')
      if (checkpoint.uncertainMutations?.length) reasons.push('effect_outcome_unknown')
      if (checkpoint.pendingTaskCreateVerifications?.some(item => item.state !== 'verified_present'))
        reasons.push('create_outcome_unverified')
      if (unresolvedCheckpointCalls(checkpoint.messages).length) reasons.push('tool_receipt_missing')
      if (archived.state === 'waiting_approval') reasons.push('approval_expired')
      if (reasons.length && (!input.review || reasons.includes('workspace_binding_changed')))
        return { status: 'needs_review', reasons, automaticEligible: false, archived }
      const toolAccess =
        checkpoint.toolAccess === 'none' || input.toolAccess === 'none'
          ? 'none'
          : checkpoint.toolAccess === 'read-only' || input.toolAccess === 'read-only'
            ? 'read-only'
            : undefined
      return {
        status: 'ready',
        reasons,
        automaticEligible: !reasons.length && (archived.state === 'working' || archived.state === 'interrupted'),
        archived,
        checkpoint: {
          ...checkpoint,
          sessionId: input.sessionId,
          generation: input.generation,
          toolAccess: reasons.length && toolAccess !== 'none' ? 'read-only' : toolAccess,
        },
      }
    },
  }
}
export const runCoordinator = createRunCoordinator()
