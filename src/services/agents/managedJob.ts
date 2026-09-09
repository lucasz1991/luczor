import { agentHub } from './hub'
import type { AgentJob, AgentRunResult } from './types'

export type ManagedAgentJobObserver = Readonly<{
  onPhase?: (phase: 'queued' | 'running' | 'awaiting_external_approval') => void
  onOutput?: (output: string) => void
}>

function abortError(): DOMException {
  return new DOMException('Agentenauftrag abgebrochen.', 'AbortError')
}

/** Approves one already-reviewed job and waits until its adapter/native worker has released its slot. */
export function executePreparedAgentJob(
  jobId: string,
  signal?: AbortSignal,
  observer: ManagedAgentJobObserver = {}
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    let last: AgentJob | undefined = agentHub.getJob(jobId)
    let lastOutput = agentHub.getOutput(jobId)
    let settled = false

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      unsubscribe()
      signal?.removeEventListener('abort', cancel)
      callback()
    }
    const inspect = () => {
      const current = agentHub.getJob(jobId)
      if (current) last = current
      const output = agentHub.getOutput(jobId)
      if (current) lastOutput = output
      if (current?.status === 'queued') observer.onPhase?.('queued')
      if (current?.status === 'running') observer.onPhase?.('running')
      if (current?.status === 'awaiting_external_approval') observer.onPhase?.('awaiting_external_approval')
      observer.onOutput?.(lastOutput)
      const vanishedAfterTerminal = !current && !!last && ['completed', 'failed', 'cancelled'].includes(last.status)
      if (!agentHub.isSettled(jobId) && !vanishedAfterTerminal) return
      if (last?.status === 'completed') {
        finish(() =>
          resolve({
            output: lastOutput,
            externalThreadId: last?.externalThreadId,
            effortSelection: last?.effortSelection,
            runtimeEvidence: last?.runtimeEvidence,
          })
        )
      } else if (signal?.aborted || last?.status === 'cancelled') {
        finish(() => reject(abortError()))
      } else {
        finish(() => reject(new Error(`Agentenauftrag fehlgeschlagen (${last?.errorCode ?? 'execution_failed'}).`)))
      }
    }
    const unsubscribe = agentHub.subscribe(inspect)
    const cancel = () => {
      agentHub.cancel(jobId)
      inspect()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) {
      cancel()
      return
    }
    if (!agentHub.approve(jobId)) {
      finish(() => reject(new Error('Der vorbereitete Agentenauftrag kann nicht gestartet werden.')))
      return
    }
    inspect()
  })
}
