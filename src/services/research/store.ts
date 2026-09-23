import type { AgentCheckpoint } from '@/services/agents/chatCheckpoint'
import { unresolvedCheckpointCalls } from '@/services/agents/continuationHistory'
import { createRunArchive, type RunArchive } from '@/services/runs/runArchive'
import type { ResearchRun } from './types'
import type { ResearchBinding, ResearchPrepareInput } from './native'

export type SavedResearch = {
  run: ResearchRun
  binding: ResearchBinding
  queries: string[]
  prepare: ResearchPrepareInput
  checkpoint?: AgentCheckpoint
  /** Payload-free marker: an ephemeral uncertain effect still needs deliberate reconciliation. */
  recoveryNeedsReview?: boolean
}
type ResearchCheckpoint = AgentCheckpoint & { researchState: Omit<SavedResearch, 'checkpoint'> }
export type ResearchStore = {
  save(value: SavedResearch): Promise<void>
  list(principalId: string): Promise<SavedResearch[]>
}

function validScope(value: SavedResearch): boolean {
  const run = value?.run
  const binding = value?.binding
  const prepare = value?.prepare
  return (
    !!run &&
    !!binding &&
    !!prepare &&
    binding.runId === run.id &&
    binding.principalId === run.principalId &&
    binding.projectId === run.projectId &&
    binding.chatId === run.conversationId &&
    binding.rootPath === run.outputDir &&
    binding.workflowScope?.principalId === run.principalId &&
    binding.workflowScope.projectId === run.projectId &&
    binding.workflowScope.runId === run.id &&
    binding.workflowScope.researchId === run.id &&
    binding.workflowScope.expectedRootPath === run.outputDir &&
    prepare.principalId === run.principalId &&
    prepare.projectId === run.projectId &&
    prepare.chatId === run.conversationId &&
    prepare.runId === run.id
  )
}

/** The encrypted run archive is authoritative. Public report files never contain tool transcripts. */
export function createResearchStore(archive: RunArchive = createRunArchive()): ResearchStore {
  return {
    async save(value) {
      if (!validScope(value)) throw new Error('research_store_scope_mismatch')
      const { run, binding, queries, prepare } = value
      const previous = value.checkpoint
      const retainWorkingContext =
        previous &&
        previous.dataPolicy !== 'ephemeral' &&
        !(previous.ephemeralDataUsed && previous.dataPolicy === undefined)
      const recoveryNeedsReview =
        value.recoveryNeedsReview === true ||
        (!retainWorkingContext &&
          !!previous &&
          (!!previous.uncertainMutations?.length ||
            unresolvedCheckpointCalls(previous.messages).length > 0 ||
            !!previous.pendingTaskCreateVerifications?.some(item => item.state !== 'verified_present')))
      const checkpoint: ResearchCheckpoint = {
        ...(retainWorkingContext
          ? previous
          : {
              projectId: run.projectId,
              principalScopeId: run.principalId,
              conversationId: run.conversationId,
              sessionId: 'research-recovery',
              generation: 0,
              objective: run.topic,
              messages: [],
              completedMutations: [],
              ephemeralDataUsed: false,
            }),
        workspaceBindingId: run.workspaceBindingId,
        dataPolicy: 'local_only',
        researchState: {
          run,
          binding,
          queries,
          prepare,
          ...(recoveryNeedsReview ? { recoveryNeedsReview: true } : {}),
        },
      }
      await archive.capture({
        principalId: run.principalId,
        projectId: run.projectId,
        conversationId: run.conversationId,
        runId: run.id,
        messageId: `research:${run.id}`,
        checkpoint,
        dataPolicy: 'local_only',
        state: run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'cancelled' : 'interrupted',
      })
    },
    async list(principalId) {
      const result: SavedResearch[] = []
      for (const item of await archive.list(principalId)) {
        if (!item.messageId.startsWith('research:')) continue
        const loaded = await archive.load(item.scope)
        const checkpoint = loaded?.checkpoint as ResearchCheckpoint | undefined
        const saved = checkpoint?.researchState
        if (
          !saved ||
          !validScope(saved) ||
          saved.run.principalId !== principalId ||
          saved.run.id !== item.scope.runId ||
          saved.run.projectId !== item.scope.projectId ||
          saved.run.conversationId !== item.scope.conversationId ||
          saved.binding.runId !== saved.run.id ||
          saved.binding.principalId !== principalId
        )
          continue
        const { researchState: _researchState, ...working } = checkpoint!
        result.push({ ...saved, checkpoint: working.messages.length ? working : undefined })
      }
      return result
    },
  }
}
