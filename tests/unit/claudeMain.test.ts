import { describe, expect, it, vi } from 'vitest'
import {
  claudeEffortForTier,
  parseClaudeMainPolicy,
  resolveClaudeModel,
  supportedThinkingTier,
} from '@/services/inference/claudeMain'
import { buildLaravelProxyBody, hashLaravelProxyBody } from '@/services/inference/laravelProxyBody'
import { parseModelUsage } from '@/services/inference/modelUsageSettings'
import { conversationHistoryForInference, messageRouteLabel } from '@/services/chatPresentation'

const block = {
  claude_modes_allowed: true,
  key_sources: ['user', 'organization', 'bogus'],
  default_model: 'claude-sonnet-5-5',
  models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: 'Stark', efforts: ['fast', 'balanced', 'ultra'] },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: 'Schnell', efforts: ['nope'] },
    { id: 'claude-opus-5-5', label: 'Duplikat' },
    { id: 'not valid!', label: 'x' },
    null,
  ],
}

describe('Claude main-model policy', () => {
  it('stays locked without a server block or without models', () => {
    expect(parseClaudeMainPolicy(undefined).allowed).toBe(false)
    expect(parseClaudeMainPolicy('yes').allowed).toBe(false)
    expect(parseClaudeMainPolicy({ claude_modes_allowed: true, models: [] }).allowed).toBe(false)
    expect(parseClaudeMainPolicy({ claude_modes_allowed: 'true', models: block.models }).allowed).toBe(false)
  })

  it('drops malformed and duplicate models and unknown key sources', () => {
    const policy = parseClaudeMainPolicy(block)
    expect(policy.allowed).toBe(true)
    expect(policy.models.map(model => model.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(policy.keySources).toEqual(['user', 'organization'])
    expect(policy.defaultModel).toBe('claude-sonnet-5-5')
    // An entry without a usable tier list accepts every tier; the server still enforces its own limits.
    expect(policy.models[1]!.efforts).toEqual(['fast', 'balanced', 'thorough', 'max', 'ultra'])
  })

  it('falls back to the first model when the default is not offered', () => {
    expect(parseClaudeMainPolicy({ ...block, default_model: 'claude-fable-5-2' }).defaultModel).toBe('claude-opus-5-5')
  })

  it('resolves chat choice, then last choice, then the default, never an unknown id', () => {
    const policy = parseClaudeMainPolicy(block)
    expect(resolveClaudeModel('claude-opus-5-5', 'claude-sonnet-5-5', policy)?.id).toBe('claude-opus-5-5')
    expect(resolveClaudeModel(undefined, 'claude-opus-5-5', policy)?.id).toBe('claude-opus-5-5')
    expect(resolveClaudeModel('removed-model', 'also-removed', policy)?.id).toBe('claude-sonnet-5-5')
    expect(resolveClaudeModel('x', 'y', parseClaudeMainPolicy(undefined))).toBeNull()
  })

  it('maps thinking tiers to provider effort and lowers an unsupported tier', () => {
    expect(['fast', 'balanced', 'thorough', 'max', 'ultra'].map(tier => claudeEffortForTier(tier as never))).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    const opus = parseClaudeMainPolicy(block).models[0]!
    expect(supportedThinkingTier(opus, 'ultra')).toBe('ultra')
    expect(supportedThinkingTier(opus, 'max')).toBe('balanced')
    expect(supportedThinkingTier(opus, 'thorough')).toBe('balanced')
  })
})

describe('Claude route modes in the device settings', () => {
  it('keeps old stored settings valid and adds the Claude block', () => {
    expect(parseModelUsage({ localModelId: 'orca', externalEnabled: true, chatRouteMode: 'auto' })).toEqual({
      localModelId: 'orca',
      externalEnabled: true,
      externalToolsEnabled: false,
      chatRouteMode: 'auto',
      claude: { enabled: false, lastModel: null },
    })
  })

  it('never keeps a Claude mode without a verified access', () => {
    expect(parseModelUsage({ chatRouteMode: 'claude_local' }).chatRouteMode).toBe('local')
    expect(parseModelUsage({ chatRouteMode: 'claude', externalEnabled: true }).chatRouteMode).toBe('local')
    expect(parseModelUsage({ chatRouteMode: 'claude', claude: { enabled: true } }).chatRouteMode).toBe('claude')
    expect(
      parseModelUsage({ chatRouteMode: 'claude_local', claude: { enabled: true, lastModel: 'bad id!' } })
    ).toMatchObject({ chatRouteMode: 'claude_local', claude: { enabled: true, lastModel: null } })
  })

  it('keeps the existing rule for external modes', () => {
    expect(parseModelUsage({ chatRouteMode: 'external', claude: { enabled: true } }).chatRouteMode).toBe('local')
    expect(parseModelUsage({ chatRouteMode: 'external', externalEnabled: true }).chatRouteMode).toBe('external')
  })
})

describe('proxy body for Claude-led turns', () => {
  const request = { messages: [{ role: 'user' as const, content: 'Hallo' }], projectId: 'p1' }

  it('adds model profile and effort only when set, so existing packets keep their hash', async () => {
    const plain = buildLaravelProxyBody(request, 'client-1', true)
    expect(plain).not.toHaveProperty('main_model_profile')
    expect(plain).not.toHaveProperty('effort')
    const claude = buildLaravelProxyBody(
      { ...request, taskType: 'chat.main', mainModelProfile: 'claude-opus-5-5', effort: 'medium' },
      'client-1',
      true
    )
    expect(claude).toMatchObject({ task_type: 'chat.main', main_model_profile: 'claude-opus-5-5', effort: 'medium' })
    expect(await hashLaravelProxyBody(request, 'client-1')).not.toBe(
      await hashLaravelProxyBody({ ...request, mainModelProfile: 'claude-opus-5-5' }, 'client-1')
    )
  })
})

describe('message route label', () => {
  it('names Claude, the local specialist and keeps the existing labels', () => {
    expect(messageRouteLabel({ inferenceTarget: 'local_llama_cpp', model: 'Orca' })).toBe('Lokal · Orca')
    expect(messageRouteLabel({ inferenceTarget: 'laravel_proxy', model: 'x/y' })).toBe('Router · x/y')
    expect(messageRouteLabel({})).toBe('')
    expect(
      messageRouteLabel({ inferenceTarget: 'laravel_proxy', model: 'claude-opus-5-5', useCase: 'main-claude' })
    ).toBe('Claude · claude-opus-5-5')
    expect(messageRouteLabel({ inferenceTarget: 'laravel_proxy', model: 'm', provider: 'Anthropic' })).toBe(
      'Claude · m'
    )
    expect(messageRouteLabel({ inferenceTarget: 'local_llama_cpp', model: 'Orca', handoff: { state: 'taken' } })).toBe(
      'Lokal · Spezial-Agent · Orca'
    )
    expect(messageRouteLabel({ inferenceTarget: 'laravel_proxy', handoff: { state: 'offered' } })).toBe('Router')
  })
})

describe('history of a Claude-led chat', () => {
  const message = (role: 'user' | 'assistant', content: string, meta: Record<string, unknown> = {}) => ({
    role,
    content,
    visibility: 'visible' as const,
    meta,
  })
  const transcript = [
    message('user', 'Frage 1'),
    message('assistant', 'Claude mit Werkzeugergebnis', {
      dataHandling: 'ephemeral',
      inferenceTarget: 'laravel_proxy',
    }),
    message('user', 'Frage 2', { dataHandling: 'ephemeral' }),
    message('assistant', 'Lokal übernommen', {
      dataHandling: 'ephemeral',
      inferenceTarget: 'local_llama_cpp',
      handoff: { state: 'taken' },
    }),
    message('assistant', 'Angebot', {
      dataHandling: 'ephemeral',
      inferenceTarget: 'laravel_proxy',
      handoff: { state: 'offered' },
    }),
  ]
  const keepEphemeral = (item: { role: string; meta: Record<string, unknown> }) =>
    item.role === 'assistant' && item.meta.inferenceTarget === 'laravel_proxy' && !item.meta.handoff

  it('keeps Claude turns built on tool results and drops every handed-over turn', () => {
    const history = conversationHistoryForInference(transcript as never, 'external', {
      keepEphemeral: keepEphemeral as never,
    })
    expect(history.messages.map(item => item.content)).toEqual(['Frage 1', 'Claude mit Werkzeugergebnis'])
  })

  it('leaves the existing external projection unchanged without the option', () => {
    expect(conversationHistoryForInference(transcript as never, 'external').messages.map(item => item.content)).toEqual(
      ['Frage 1']
    )
  })
})

describe('account setup stored on the server', () => {
  const withAccess = (access: unknown) => parseClaudeMainPolicy({ ...block, access })

  it('reads the setup fail-closed and never trusts an unknown model or source', () => {
    expect(parseClaudeMainPolicy(block).access).toBeNull()
    expect(
      withAccess({ connected: true, source: 'user', provider_fallback: true, preferred_model: 'claude-opus-5-5' })
        .access
    ).toEqual({ connected: true, source: 'user', providerFallback: true, preferredModel: 'claude-opus-5-5' })
    expect(withAccess({ connected: true, source: 'someone', preferred_model: 'removed-model' }).access).toEqual({
      connected: false,
      source: null,
      providerFallback: false,
      preferredModel: null,
    })
    expect(withAccess({ connected: 'yes', source: 'organization' }).access?.connected).toBe(false)
  })

  it('lets a second device adopt access and model, and locks it again when the access is gone', async () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
    const settings = await import('@/services/inference/modelUsageSettings')
    const { adoptClaudeAccountSetup } = await import('@/services/inference/claudeMain')
    settings.modelUsageSettings.value = { ...settings.DEFAULT_MODEL_USAGE }

    const connected = withAccess({ connected: true, source: 'user', preferred_model: 'claude-sonnet-5-5' })
    expect(await adoptClaudeAccountSetup(connected)).toBe(true)
    expect(settings.modelUsageSettings.value.claude).toEqual({ enabled: true, lastModel: 'claude-sonnet-5-5' })
    // Nothing to write when the device already matches the account.
    expect(await adoptClaudeAccountSetup(connected)).toBe(false)

    await settings.saveModelUsageSettings({ ...settings.modelUsageSettings.value, chatRouteMode: 'claude_local' })
    expect(settings.modelUsageSettings.value.chatRouteMode).toBe('claude_local')
    // The key was removed on another device: this one keeps its model choice but leaves the Claude mode.
    expect(await adoptClaudeAccountSetup(withAccess({ connected: false, source: null }))).toBe(true)
    expect(settings.modelUsageSettings.value).toMatchObject({
      chatRouteMode: 'local',
      claude: { enabled: false, lastModel: 'claude-sonnet-5-5' },
    })
    // An older server sends no setup and must not change the device.
    expect(await adoptClaudeAccountSetup(parseClaudeMainPolicy(block))).toBe(false)
    vi.unstubAllGlobals()
  })
})
