import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ config: vi.fn(), profile: vi.fn() }))
vi.mock('@/services/api/luczorApi', () => ({
  getApiConfigSnapshot: mocks.config,
  assistantProfileWithApiConfig: mocks.profile,
}))
import {
  assistantProfileState,
  localAssistantProfilePrompt,
  parseAssistantProfile,
  prepareInternalModelMessages,
  refreshAssistantProfile,
  resetAssistantProfile,
} from '@/services/assistantProfile'
import draft from '@/services/assistantProfileDraft.json'
import type { AssistantProfile } from '@/services/assistantProfileTypes'
import type { WireMessage } from '@/services/inference/types'

const profile = {
  persona: { slug: 'custom', name: 'Persönlich', prompt: 'Fremde Kontodaten' },
  skills: [],
  revision: 'abc',
}
const config = { baseUrl: 'https://local.example', deviceKey: 'test-only', clientId: 'device' }
const internalProfile: AssistantProfile = {
  ...profile,
  internal_models: {
    standard: { enabled: true, personality: 'INTERNAL_PERSONALITY', system_prompt: 'INTERNAL_SYSTEM' },
    external_agents: { enabled: true, personality: 'AGENT_PERSONALITY', system_prompt: 'AGENT_SYSTEM' },
  },
}
beforeEach(() => {
  resetAssistantProfile()
  vi.clearAllMocks()
  mocks.config.mockResolvedValue(config)
})
describe('assistant profile binding and local draft', () => {
  it('uses independent internal profiles with system instructions before personality', () => {
    const parsed = parseAssistantProfile(internalProfile)
    const standard = localAssistantProfilePrompt(parsed)
    expect(standard).toContain('INTERNAL_PERSONALITY')
    expect(standard.indexOf('INTERNAL_SYSTEM')).toBeLessThan(standard.indexOf('INTERNAL_PERSONALITY'))
    expect(standard).not.toContain(profile.persona.prompt)
    const externalMode = localAssistantProfilePrompt(parsed, '', 'chat.general', 'external_agents')
    expect(externalMode).toContain('AGENT_SYSTEM')
    expect(externalMode).toContain('AGENT_PERSONALITY')
    expect(externalMode).not.toContain('INTERNAL_PERSONALITY')
  })
  it('falls back from disabled external-agent override to internal standard then legacy', () => {
    const parsed = structuredClone(internalProfile)
    parsed.internal_models!.external_agents.enabled = false
    expect(localAssistantProfilePrompt(parsed, '', 'chat.general', 'external_agents')).toContain('INTERNAL_SYSTEM')
    parsed.internal_models!.standard.enabled = false
    expect(localAssistantProfilePrompt(parsed, '', 'chat.general', 'external_agents')).toContain(profile.persona.prompt)
  })
  it('respects explicitly empty enabled profiles without resurrecting a previous personality', () => {
    const parsed = structuredClone(internalProfile)
    parsed.internal_models!.external_agents = { enabled: true, personality: '', system_prompt: '' }
    expect(localAssistantProfilePrompt(parsed, '', 'chat.general', 'external_agents')).toBe('')
    expect(localAssistantProfilePrompt(parsed)).toContain('INTERNAL_SYSTEM')
  })
  it('preserves full accepted Unicode instruction lengths and appends relevant skills', () => {
    const parsed = structuredClone(internalProfile)
    parsed.internal_models!.standard = {
      enabled: true,
      personality: '🙂'.repeat(2000),
      system_prompt: 'ä'.repeat(4000),
    }
    parsed.skills = [{ ...draft.skills[0]!, kind: 'prompt', prompt: 'GLOBAL_SKILL', tags: ['always'] }]
    const prompt = localAssistantProfilePrompt(parseAssistantProfile(parsed))
    expect(prompt).toContain(parsed.internal_models!.standard.system_prompt)
    expect(prompt).toContain(parsed.internal_models!.standard.personality)
    expect(prompt).toContain('GLOBAL_SKILL')
  })
  it('replaces a carried profile once without changing history, base instructions, or source arrays', async () => {
    mocks.profile.mockResolvedValue({ data: internalProfile })
    const messages: WireMessage[] = [
      { role: 'system', content: `Base rules\n\n${localAssistantProfilePrompt(profile)}` },
      { role: 'user', content: '[LUCZOR-PROFILE]Quoted data[LUCZOR-PROFILE-END]' },
    ]
    const original = structuredClone(messages)
    const first = await prepareInternalModelMessages(messages, 'local_llama_cpp')
    const next = await prepareInternalModelMessages(first, 'local_llama_cpp', { mode: 'external_agents' })
    expect(messages).toEqual(original)
    expect(
      next.filter(message => message.role === 'system' && message.content.includes('[LUCZOR-PROFILE]'))
    ).toHaveLength(1)
    expect(next[0]!.content).toContain('AGENT_SYSTEM')
    expect(JSON.stringify(next)).not.toContain('INTERNAL_SYSTEM')
    expect(next).toContainEqual({ role: 'system', content: 'Base rules' })
    expect(next.at(-1)).toEqual(original.at(-1))
    expect(mocks.profile).toHaveBeenCalledOnce()
  })
  it('does not load profiles or change an external packet in either mode', async () => {
    const messages: WireMessage[] = [
      { role: 'system', content: 'Approved rules' },
      { role: 'user', content: 'Question' },
    ]
    for (const mode of ['standard', 'external_agents'] as const)
      expect(await prepareInternalModelMessages(messages, 'laravel_proxy', { mode })).toBe(messages)
    expect(mocks.profile).not.toHaveBeenCalled()
    expect(mocks.config).not.toHaveBeenCalled()
  })
  it('keeps specialized task instructions unchanged when no internal override is enabled', async () => {
    mocks.profile.mockResolvedValue({ data: profile })
    const messages: WireMessage[] = [{ role: 'system', content: 'Return JSON only' }]
    expect(await prepareInternalModelMessages(messages, 'local_llama_cpp', { configuredOnly: true })).toBe(messages)
  })
  it('releases cancelled callers while a shared profile refresh continues for other consumers', async () => {
    let finish!: (result: unknown) => void
    mocks.profile.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const controller = new AbortController()
    const cancelled = prepareInternalModelMessages([], 'local_llama_cpp', { signal: controller.signal })
    const surviving = prepareInternalModelMessages([], 'local_llama_cpp')
    await vi.waitFor(() => expect(mocks.profile).toHaveBeenCalledOnce())
    const rejected = cancelled.catch(error => error)
    controller.abort()
    await expect(rejected).resolves.toMatchObject({ name: 'AbortError' })
    finish({ data: internalProfile })
    expect(JSON.stringify(await surviving)).toContain('INTERNAL_SYSTEM')
    expect(mocks.profile).toHaveBeenCalledOnce()
  })
  it.each([
    { enabled: 'true', personality: '', system_prompt: '' },
    { enabled: true, personality: 'x'.repeat(2001), system_prompt: '' },
    { enabled: true, personality: '', system_prompt: 'x'.repeat(4001) },
    { enabled: true, personality: null, system_prompt: '' },
  ])('rejects malformed internal settings %#', standard => {
    expect(() =>
      parseAssistantProfile({ ...internalProfile, internal_models: { ...internalProfile.internal_models, standard } })
    ).toThrow('Invalid internal model profile')
  })
  it('contains the confirmed draft and all three conditional skills', () => {
    const parsed = parseAssistantProfile(draft)
    expect(parsed.skills).toHaveLength(3)
    expect(localAssistantProfilePrompt(parsed)).toContain('keine Werkzeug-, Datei- oder Netzwerkfreigaben')
    expect(localAssistantProfilePrompt(parsed, 'Hallo')).not.toContain('Skill:')
    expect(localAssistantProfilePrompt(parsed, 'Laravel Fehler prüfen', 'coding.fix_bug')).toContain(
      'Bei Laravel- und PHP-Aufgaben'
    )
  })
  it('respects an explicitly empty admin selection', async () => {
    mocks.profile.mockResolvedValue({ data: { persona: null, skills: [], revision: 'empty' } })
    const result = await refreshAssistantProfile()
    expect(localAssistantProfilePrompt(result)).toBe('')
    expect(assistantProfileState.source).toBe('admin')
    mocks.profile.mockRejectedValueOnce(new Error('offline'))
    expect(localAssistantProfilePrompt(await refreshAssistantProfile(true))).toBe('')
    expect(assistantProfileState.message).toContain('Zuletzt geladenes Admin-Profil')
  })
  it('normalizes optional empty descriptions and tags without losing the admin selection', () => {
    const skill = { ...draft.skills[0], description: null, tags: null }
    expect(parseAssistantProfile({ ...profile, skills: [skill] }).skills[0]).toMatchObject({
      description: '',
      tags: [],
    })
  })
  it('loads an authenticated profile once and permits explicit refresh', async () => {
    mocks.profile.mockResolvedValue({ data: profile })
    await refreshAssistantProfile()
    await refreshAssistantProfile()
    expect(mocks.profile).toHaveBeenCalledTimes(1)
    await refreshAssistantProfile(true)
    expect(mocks.profile).toHaveBeenCalledTimes(2)
    expect(assistantProfileState.profile.persona?.slug).toBe('custom')
  })
  it('joins concurrent initial chat and status loads instead of returning the draft', async () => {
    mocks.profile.mockResolvedValue({ data: profile })
    const profiles = await Promise.all([refreshAssistantProfile(), refreshAssistantProfile()])
    expect(profiles.map(item => item.persona?.slug)).toEqual(['custom', 'custom'])
    expect(mocks.profile).toHaveBeenCalledOnce()
  })
  it('never reuses an old account profile after a credential change and failed refresh', async () => {
    mocks.profile.mockResolvedValueOnce({ data: profile })
    await refreshAssistantProfile()
    mocks.config.mockResolvedValue({ ...config, deviceKey: 'different-test-only' })
    mocks.profile.mockRejectedValueOnce(new Error('private failure details'))
    const result = await refreshAssistantProfile()
    expect(result).toEqual(draft)
    expect(assistantProfileState.source).toBe('draft')
    expect(assistantProfileState.message).not.toContain('private failure')
  })
  it('discards a response arriving after identity invalidation', async () => {
    let finish!: (result: unknown) => void
    mocks.profile.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const pending = refreshAssistantProfile()
    await vi.waitFor(() => expect(mocks.profile).toHaveBeenCalledOnce())
    resetAssistantProfile()
    finish({ data: profile })
    expect(await pending).toEqual(draft)
    expect(assistantProfileState.profile.persona?.slug).not.toBe('custom')
  })
  it('rejects malformed and oversized profile payloads', () => {
    expect(() => parseAssistantProfile({ ...profile, persona: {} })).toThrow()
    expect(() => parseAssistantProfile({ ...profile, skills: [{ kind: 'workflow' }] })).toThrow()
    expect(() =>
      parseAssistantProfile({ ...profile, persona: { ...profile.persona, prompt: 'x'.repeat(20001) } })
    ).toThrow()
  })
})
