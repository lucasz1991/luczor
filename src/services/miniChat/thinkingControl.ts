import { watch } from 'vue'
import {
  readThinkingProgress,
  type ThinkingBudgetProgress,
  type ThinkingControlAction,
} from '@/services/inference/thinking'
import type { MiniAction, MiniSnapshot } from './types'

/** An emitted mini-window action is transport delivery, not a runtime acknowledgement. */
export function createMiniThinkingControl(
  snapshot: () => MiniSnapshot,
  send: (action: MiniAction) => void,
  connectionError: () => string = () => ''
) {
  let cancelPending: (() => void) | null = null
  let disposed = false
  function control(
    requestId: string,
    action: ThinkingControlAction,
    sequence: number
  ): Promise<ThinkingBudgetProgress> {
    const current = snapshot()
    if (disposed || cancelPending || connectionError() || current.thinkingBudget?.requestId !== requestId)
      return Promise.reject(
        new Error('Die Verbindung zum aktiven Auftrag ist nicht verfügbar oder eine Steuerung wartet noch.')
      )
    const controlId = crypto.randomUUID()
    const sessionId = current.sessionId
    return new Promise((resolve, reject) => {
      let settled = false
      let stop = () => {}
      const finish = (progress?: ThinkingBudgetProgress, error?: string) => {
        if (settled) return
        settled = true
        stop()
        clearTimeout(timer)
        cancelPending = null
        if (progress) resolve(progress)
        else reject(new Error(error ?? 'Diese Modellgeneration wurde beendet oder gewechselt.'))
      }
      cancelPending = () => finish()
      stop = watch(
        () => [snapshot(), connectionError()] as const,
        ([value, error]) => {
          if (error || value.sessionId !== sessionId || value.thinkingBudget?.requestId !== requestId) {
            finish(undefined, error || undefined)
            return
          }
          const ack = value.thinkingControlAck
          if (ack?.controlId !== controlId || ack.requestId !== requestId) return
          const progress = readThinkingProgress(ack.progress)
          if (ack.error) finish(undefined, ack.error)
          else if (progress?.requestId === requestId) finish(progress)
          else finish(undefined, 'Die Runtime hat keinen gültigen Steuerungsstand bestätigt.')
        },
        { deep: true, flush: 'sync' }
      )
      const timer = setTimeout(
        () => finish(undefined, 'Keine Steuerungsbestätigung empfangen. Es wurde keine Aktion automatisch wiederholt.'),
        10_000
      )
      try {
        send({ type: 'thinking_control', sessionId, requestId, controlId, action, sequence })
      } catch {
        finish(undefined, 'Budgetsteuerung konnte nicht übermittelt werden.')
      }
    })
  }
  return {
    control,
    dispose() {
      disposed = true
      cancelPending?.()
    },
  }
}
