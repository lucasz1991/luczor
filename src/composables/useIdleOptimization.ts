import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Store } from '@tauri-apps/plugin-store'
import { onExecutionInvalidated } from '@/services/executionGate'
import {
  createIdleOptimization,
  IDLE_OPTIMIZATION_KEY,
  idleOptimizationEnabled,
  idleOptimizationStatus,
  loadIdleOptimizationSetting,
  registerIdleOptimizationRequest,
  type IdleOptimizationContext,
} from '@/services/agents/idleOptimization'
import { MEMORY_GRAPH_DISPLAY_KEY } from '@/features/memory/graphDisplay'
import { IDLE_EMERGENCY_OFFLOAD_KEY } from '@/services/agents/idleOffloadSetting'
import { localResources } from '@/services/inference/resources'
import { isMaintenanceWrite } from '@/services/memory/luczorMemory'

export function useIdleOptimization(context: IdleOptimizationContext & { draft(): string }) {
  const identityChanging = ref(false)
  const optimizer = createIdleOptimization({ ...context, busy: () => context.busy() || identityChanging.value })
  let disposed = false
  let globallyStopped = false
  const unlistenStores: Array<() => void> = []
  const releaseAdmission = localResources.setForegroundAdmission(signal => optimizer.acquireForeground(signal))
  const releaseManualRequest = registerIdleOptimizationRequest(
    () => optimizer.requestNow(),
    () => optimizer.manualBlocker()
  )
  const releaseStatus = optimizer.subscribe(state => {
    idleOptimizationStatus.value = state
  })
  const releaseInvalidation = onExecutionInvalidated(() => optimizer.interrupt('boundary_changed'))
  const activity = () => optimizer.interrupt('activity')
  // A real idle period means no meaningful input, not merely an unchanged draft.
  // Deliberately avoid pointermove: hovering must not continuously postpone work.
  const userInteraction = () => {
    if (['running', 'committing', 'yielding'].includes(optimizer.snapshot().phase)) return
    activity()
  }
  const interactionTarget = typeof document === 'undefined' ? null : document
  const changing = () => {
    identityChanging.value = true
    optimizer.interrupt('boundary_changed')
  }
  const changed = () => {
    identityChanging.value = false
    optimizer.interrupt('boundary_changed')
  }
  watch([context.busy, context.draft, () => context.project()?.id], activity, { flush: 'sync' })
  watch(idleOptimizationEnabled, enabled => {
    if (!disposed && !globallyStopped && enabled) optimizer.start()
    else void optimizer.stop()
  })
  onMounted(async () => {
    interactionTarget?.addEventListener('pointerdown', userInteraction, { passive: true })
    interactionTarget?.addEventListener('keydown', userInteraction)
    interactionTarget?.addEventListener('touchstart', userInteraction, { passive: true })
    interactionTarget?.addEventListener('focusin', userInteraction)
    window.addEventListener('luczor:api-identity-changing', changing)
    window.addEventListener('luczor:api-identity-changed', changed)
    window.addEventListener('beforeunload', changing)
    try {
      const memory = await Store.load('luczor.memory.json')
      const settings = await Store.load('luczor.settings.json')
      const disposeMemory = await memory.onChange((_key, value) => {
        if (isMaintenanceWrite(value)) return
        if (optimizer.snapshot().phase !== 'committing') optimizer.interrupt('memory_changed')
      })
      if (disposed) {
        disposeMemory()
        return
      }
      unlistenStores.push(disposeMemory)
      const disposeSettings = await settings.onChange(key => {
        // The enable toggle and pure display preferences must not cancel the pass they just requested.
        if (key !== IDLE_OPTIMIZATION_KEY && key !== IDLE_EMERGENCY_OFFLOAD_KEY && key !== MEMORY_GRAPH_DISPLAY_KEY)
          optimizer.interrupt('settings_changed')
        void loadIdleOptimizationSetting().catch(() => {
          idleOptimizationEnabled.value = false
        })
      })
      if (disposed) {
        disposeSettings()
        return
      }
      unlistenStores.push(disposeSettings)
      await loadIdleOptimizationSetting()
      if (!disposed && !globallyStopped && idleOptimizationEnabled.value) optimizer.start()
    } catch {
      idleOptimizationEnabled.value = false
    }
  })
  onBeforeUnmount(() => {
    disposed = true
    void optimizer.stop().finally(releaseAdmission)
    releaseStatus()
    releaseInvalidation()
    releaseManualRequest()
    unlistenStores.forEach(unlisten => unlisten())
    interactionTarget?.removeEventListener('pointerdown', userInteraction)
    interactionTarget?.removeEventListener('keydown', userInteraction)
    interactionTarget?.removeEventListener('touchstart', userInteraction)
    interactionTarget?.removeEventListener('focusin', userInteraction)
    window.removeEventListener('luczor:api-identity-changing', changing)
    window.removeEventListener('luczor:api-identity-changed', changed)
    window.removeEventListener('beforeunload', changing)
  })
  return {
    stop: () => {
      globallyStopped = true
      return optimizer.stop()
    },
    recoverAfterStop: () => optimizer.recoverAfterStop(),
    /** Only the user's explicit execution-resume action re-enables the saved idle preference. */
    start: () => {
      globallyStopped = false
      if (!disposed && idleOptimizationEnabled.value) optimizer.start()
    },
  }
}
