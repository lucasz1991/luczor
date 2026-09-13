import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRenderer, h } from 'vue'

const mocks = vi.hoisted(() => ({
  unload: vi.fn(async () => {}),
  resolve: vi.fn(async () => ({ gateway: { target: 'local_llama_cpp' }, decision: { modelReleaseId: 'small' } })),
  capture: vi.fn(() => ({ sessionId: 'session' })),
  assert: vi.fn(),
}))
vi.mock('@/services/inference/modelUsageSettings', async () => {
  const { shallowRef } = await import('vue')
  return { modelUsageSettings: shallowRef({ localModelId: 'large', externalEnabled: false }) }
})
vi.mock('@/services/inference/coordinator', () => ({
  localInferenceCoordinator: {
    unloadResidentForModelChange: mocks.unload,
    resolveTurn: mocks.resolve,
  },
}))
vi.mock('@/services/executionGate', () => ({ executionGate: { capture: mocks.capture, assert: mocks.assert } }))
vi.mock('@/services/inference/resources', () => ({
  localResources: {
    switchModel: async (operation: () => Promise<void>) => {
      await Promise.resolve()
      await operation()
    },
  },
}))

import { modelUsageSettings } from '@/services/inference/modelUsageSettings'
import { useLocalModelSwitch } from '@/composables/useLocalModelSwitch'

type HostNode = { children: HostNode[] }
const node = (): HostNode => ({ children: [] })
const renderer = createRenderer<HostNode, HostNode>({
  createElement: node,
  createText: node,
  createComment: node,
  insert: (child, parent) => {
    parent.children.push(child)
  },
  remove: () => {},
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  parentNode: () => null,
  nextSibling: () => null,
})
let unmount: (() => void) | undefined
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  modelUsageSettings.value = { localModelId: 'large', externalEnabled: false, chatRouteMode: 'local' }
})
afterEach(() => {
  unmount?.()
  vi.unstubAllGlobals()
})

it('starts switching only after a changed saved local selection, independently of background warmup settings', async () => {
  let switcher!: ReturnType<typeof useLocalModelSwitch>
  const app = renderer.createApp({
    setup() {
      switcher = useLocalModelSwitch()
      return () => h('div')
    },
  })
  app.mount(node())
  unmount = () => app.unmount()
  expect(mocks.unload).not.toHaveBeenCalled()
  modelUsageSettings.value = { ...modelUsageSettings.value, externalEnabled: true }
  expect(mocks.unload).not.toHaveBeenCalled()
  modelUsageSettings.value = { ...modelUsageSettings.value, localModelId: 'small' }
  expect(switcher.state.value.phase).toBe('waiting')
  await vi.waitFor(() => expect(switcher.state.value.phase).toBe('ready'))
  expect(mocks.unload).toHaveBeenCalledExactlyOnceWith('small', expect.any(Function))
  expect(mocks.resolve).toHaveBeenCalledWith(
    expect.objectContaining({
      contextEgress: 'local_only',
      routingSettings: { preference: 'local_only', localModelId: 'small', allowDegradedLocal: false },
    })
  )
  expect(mocks.assert).toHaveBeenCalled()
  modelUsageSettings.value = { ...modelUsageSettings.value }
  expect(mocks.unload).toHaveBeenCalledExactlyOnceWith('small', expect.any(Function))
})

it('does not attempt native model preparation in a browser preview', async () => {
  vi.stubGlobal('window', {})
  const app = renderer.createApp({
    setup() {
      useLocalModelSwitch()
      return () => h('div')
    },
  })
  app.mount(node())
  unmount = () => app.unmount()
  modelUsageSettings.value = { ...modelUsageSettings.value, localModelId: 'small' }
  await Promise.resolve()
  expect(mocks.unload).not.toHaveBeenCalled()
})
