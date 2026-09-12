import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as VueRuntime from 'vue'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import settingsSource from '@/components/Settings.vue?raw'
import type { InferenceConnectionResult } from '@/services/inference/coordinator'

const appliedModelUsage = VueRuntime.ref({
  localModelId: null as string | null,
  externalEnabled: false,
  agentsByDefault: false,
  teamPreset: 'local',
  chatRouteMode: 'local',
})
const saveModels = vi.fn(async (value: typeof appliedModelUsage.value) => {
  appliedModelUsage.value = { ...value }
})
const persist = vi.fn(async () => false)
const recover = vi.fn<() => Promise<InferenceConnectionResult>>()
const legacyConnectionTest = vi.fn()
const store = { get: vi.fn(), set: vi.fn(), save: vi.fn(), delete: vi.fn() }
const descriptor = parse(settingsSource, { filename: 'Settings.vue' }).descriptor
const compiled = compileScript(descriptor, { id: 'settings-recovery-test' })
const transpiled = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

type SettingsSetup = {
  modelUsageDraft: typeof appliedModelUsage
  selectTab(id: string): void
  ensureStoreLoaded(): Promise<void>
  testServer(): Promise<void>
  saveAll(): Promise<void>
  settings: { chat_tool_rounds: number; agent_tool_rounds: number; voice_tts_voice_id: string }
  ui: {
    saved: boolean
    error: string | null
    serverBusy: boolean
    serverResult: { ok: boolean; message: string } | null
  }
}

function setup(): SettingsSetup {
  const module = { exports: {} as { default?: { setup: (props: unknown, context: unknown) => SettingsSetup } } }
  const modules = new Map<string, unknown>([
    ['vue', { ...VueRuntime, onMounted() {}, onBeforeUnmount() {}, watch() {} }],
    [
      '@/services/inference/modelUsageSettings',
      { modelUsageSettings: appliedModelUsage, saveModelUsageSettings: saveModels },
    ],
    ['@tauri-apps/plugin-store', { Store: { load: async () => store } }],
    [
      '@/services/voice/speechConsent',
      { loadLocalSpeechConsent: async () => false, saveLocalSpeechConsent: async () => undefined },
    ],
    ['@/services/tools/registry', { listTools: () => [] }],
    ['@/services/secureDeviceKey', { loadDeviceKey: async () => 'fixture-key' }],
    ['@/services/apiIdentitySettings', { persistApiIdentity: persist, DISABLED_API_BASE_URL: 'about:blank' }],
    ['@/services/api/sync', { testConnection: legacyConnectionTest }],
    [
      '@/services/api/luczorApi',
      { DEFAULT_BASE_URL: 'https://server.example.test', getApiConfig: async () => ({ clientId: 'fixture' }) },
    ],
    ['@/services/inference/coordinator', { reinitializeLocalInferenceForCurrentApi: recover }],
    [
      '@/services/toolLimits',
      {
        DEFAULT_TOOL_LIMITS: { chat: 6, agent: 12 },
        loadToolLimits: async () => ({ chat: 6, agent: 12 }),
        validToolRounds: (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 64,
      },
    ],
    ['@/services/executionPolicy', { DEFAULT_EXECUTION_POLICY: {} }],
    ['@/services/inference/hybridRouter', {}],
    ['@/services/appearance', { loadAppearance: async () => {} }],
    ['@/services/notifications', {}],
    [
      '@/services/voice/localVoice',
      {
        VOICE_DEFAULTS: {},
        getVoiceConfig: async () => ({}),
        voiceSettingsToStore: () => ({}),
        validateVoiceSettings: () => null,
        resolveVoiceSettings: () => ({}),
      },
    ],
  ])
  runInNewContext(transpiled, {
    module,
    Error,
    Event,
    window: { dispatchEvent() {}, setTimeout() {} },
    exports: module.exports,
    require(id: string) {
      if (id.endsWith('.vue')) return {}
      if (modules.has(id)) return modules.get(id)
      throw new Error(`Unexpected import: ${id}`)
    },
  })
  return module.exports.default!.setup({ open: false, initialTab: 'server' }, { expose() {}, emit() {} })
}

function result(ok: boolean, stale = false): InferenceConnectionResult {
  return {
    ok,
    connected: true,
    stale,
    message: ok ? 'Server verbunden. Richtlinie geprüft.' : 'Server verbunden. Richtlinie nicht verfügbar.',
    policy: { mode: ok ? 'active' : 'blocked', reason: 'test', message: 'test' },
  }
}

beforeEach(() => {
  appliedModelUsage.value = {
    localModelId: null,
    externalEnabled: false,
    agentsByDefault: false,
    teamPreset: 'local',
    chatRouteMode: 'local',
  }
  saveModels.mockClear()
  persist.mockReset().mockResolvedValue(false)
  recover.mockReset().mockResolvedValue(result(true))
  legacyConnectionTest.mockReset()
})

describe('Settings connection retry', () => {
  it.each([false, true])(
    'retains the selected V2 voice only for the same server identity (changed=%s)',
    async changed => {
      persist.mockResolvedValue(changed)
      store.get.mockImplementation(async key => (key === 'voice_tts_voice_id' ? 'benni' : undefined))
      try {
        const settings = setup()
        await settings.ensureStoreLoaded()
        expect(settings.settings.voice_tts_voice_id).toBe('benni')
        store.set.mockClear()
        await settings.saveAll()
        expect(store.set).toHaveBeenCalledWith('voice_tts_voice_id', changed ? '' : 'benni')
      } finally {
        store.get.mockReset()
      }
    }
  )

  it('persists both limits through the real Settings save handler and rejects invalid drafts', async () => {
    const settings = setup()
    await settings.ensureStoreLoaded()
    store.set.mockClear()
    settings.settings.chat_tool_rounds = 20
    settings.settings.agent_tool_rounds = 32
    await settings.saveAll()
    expect(store.set).toHaveBeenCalledWith('chat_tool_rounds', 20)
    expect(store.set).toHaveBeenCalledWith('agent_tool_rounds', 32)
    store.set.mockClear()
    settings.settings.chat_tool_rounds = 0
    await settings.saveAll()
    expect(settings.ui.error).toContain('zwischen 1 und 64')
    expect(store.set).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'awaits one policy check with changed identity=%s instead of a health-only success',
    async changed => {
      persist.mockResolvedValue(changed)
      let finish!: (value: InferenceConnectionResult) => void
      recover.mockReturnValueOnce(
        new Promise(resolve => {
          finish = resolve
        })
      )
      const settings = setup()
      await settings.ensureStoreLoaded()
      const pending = settings.testServer()
      await vi.waitFor(() => expect(recover).toHaveBeenCalledExactlyOnceWith({ diagnoseUnavailable: true }))
      expect(settings.ui.serverBusy).toBe(true)
      expect(settings.ui.serverResult).toBeNull()
      await settings.testServer()
      expect(recover).toHaveBeenCalledOnce()
      finish(result(false))
      await pending
      expect(settings.ui.serverBusy).toBe(false)
      expect(settings.ui.serverResult).toMatchObject({
        ok: false,
        message: 'Server verbunden. Richtlinie nicht verfügbar.',
      })
      expect(legacyConnectionTest).not.toHaveBeenCalled()
    }
  )

  it('does not show a stale account result', async () => {
    recover.mockResolvedValueOnce(result(true, true))
    const settings = setup()
    await settings.ensureStoreLoaded()
    await settings.testServer()
    expect(settings.ui.serverResult).toBeNull()
  })

  it('never prints an unexpected native recovery error', async () => {
    recover.mockRejectedValueOnce(new Error('SECRET_KEYCHAIN_DATA'))
    const settings = setup()
    await settings.ensureStoreLoaded()
    await settings.testServer()
    expect(settings.ui.serverResult?.ok).toBe(false)
    expect(settings.ui.serverResult?.message).not.toContain('SECRET_KEYCHAIN_DATA')
  })
})

describe('model selection through the shared settings save action', () => {
  it('retains all model options across tab switches and a fresh settings instance', async () => {
    const first = setup()
    await first.ensureStoreLoaded()
    const choice = {
      localModelId: 'local-tier-light',
      externalEnabled: true,
      agentsByDefault: true,
      teamPreset: 'free',
      chatRouteMode: 'auto',
    }
    first.modelUsageDraft.value = choice
    first.selectTab('server')
    await first.saveAll()
    expect(saveModels).toHaveBeenCalledWith(choice)
    expect(first.ui.saved).toBe(true)
    const reopened = setup()
    await reopened.ensureStoreLoaded()
    expect(reopened.modelUsageDraft.value).toEqual(choice)
  })
  it('reports a model persistence failure without claiming success or replacing applied values', async () => {
    const view = setup()
    await view.ensureStoreLoaded()
    view.modelUsageDraft.value.localModelId = 'local-tier-light'
    saveModels.mockRejectedValueOnce(new Error('Disk write failed'))
    await view.saveAll()
    expect(view.ui.error).toBe('Disk write failed')
    expect(view.ui.saved).toBe(false)
    expect(appliedModelUsage.value.localModelId).toBeNull()
  })
})
