import { onMounted, onBeforeUnmount, watch } from 'vue'
import { executionGate, onExecutionInvalidated } from '@/services/executionGate'
import { workflowChanged } from '@/services/workflows/presentation'
import { startWorkflowWatchers, stopWorkflowWatchers } from '@/services/workflows/watcher'

/** Serial lifecycle ownership prevents stale setup from stopping a newer account session. */
export function useWorkflowWatchers() {
  let generation = 0
  let mounted = false
  let identityChanging = false
  let queue: Promise<unknown> = Promise.resolve()
  const restart = () => {
    const expected = ++generation
    stopWorkflowWatchers()
    if (!mounted || identityChanging || !('__TAURI_INTERNALS__' in window)) return
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        const controls = executionGate.snapshot()
        if (
          generation !== expected ||
          !mounted ||
          identityChanging ||
          controls.killSwitch ||
          controls.mode === 'observe'
        )
          return
        const stop = await startWorkflowWatchers()
        if (generation !== expected || !mounted) stop()
      })
      .catch(() => undefined)
  }
  const changing = () => {
    identityChanging = true
    restart()
  }
  const changed = () => {
    identityChanging = false
    restart()
  }
  const stopInvalidation = onExecutionInvalidated(restart)
  const stopChanges = watch(workflowChanged, restart)
  onMounted(() => {
    mounted = true
    window.addEventListener('luczor:api-identity-changing', changing)
    window.addEventListener('luczor:api-identity-changed', changed)
    window.addEventListener('luczor:workflow-automation-changed', restart)
    restart()
  })
  onBeforeUnmount(() => {
    mounted = false
    generation++
    stopWorkflowWatchers()
    stopInvalidation()
    stopChanges()
    window.removeEventListener('luczor:api-identity-changing', changing)
    window.removeEventListener('luczor:api-identity-changed', changed)
    window.removeEventListener('luczor:workflow-automation-changed', restart)
  })
  return {
    /** Stop old setup ownership after native acknowledgement; restart waits for explicit gate permission. */
    recoverAfterStop() {
      generation++
      stopWorkflowWatchers()
      queue = Promise.resolve()
    },
  }
}
