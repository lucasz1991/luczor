import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import { executionGate } from '@/services/executionGate'
import { localInferenceCoordinator } from '@/services/inference/coordinator'
import { modelUsageSettings } from '@/services/inference/modelUsageSettings'
import { LocalModelSwitch, modelSwitchIsPending } from '@/services/inference/modelSwitch'
import { localResources } from '@/services/inference/resources'

/** Mounted once by the main window; secondary chats use its existing run progress channel. */
export function useLocalModelSwitch() {
  const controller = new LocalModelSwitch({
    exclusive: operation => localResources.switchModel(operation),
    unload: (id, onUnloading) => localInferenceCoordinator.unloadResidentForModelChange(id, onUnloading),
    async prepare(id) {
      const route = await localInferenceCoordinator.resolveTurn({
        projectId: '__luczor_model_switch__',
        taskType: 'chat.general',
        contextEgress: 'local_only',
        routingSettings: { preference: 'local_only', localModelId: id, allowDegradedLocal: false },
      })
      if (route.gateway.target !== 'local_llama_cpp' || !route.decision?.modelReleaseId)
        throw new Error('local_model_switch_not_ready')
      return route.decision.modelReleaseId
    },
  })
  const state = shallowRef(controller.snapshot())
  const unsubscribe = controller.subscribe(value => {
    state.value = value
  })
  const pending = computed(() => modelSwitchIsPending(state.value))
  const request = () => {
    if (!('__TAURI_INTERNALS__' in window)) return
    const ticket = executionGate.capture()
    void controller
      .request(modelUsageSettings.value.localModelId, () => executionGate.assert(ticket))
      .catch(() => undefined)
  }
  // Persistence publishes only after the device store has confirmed saving.
  watch(() => modelUsageSettings.value.localModelId, request, { flush: 'sync' })
  onBeforeUnmount(unsubscribe)
  return { state, pending, retry: request }
}
