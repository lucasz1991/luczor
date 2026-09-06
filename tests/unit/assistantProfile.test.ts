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
  refreshAssistantProfile,
  resetAssistantProfile,
} from '@/services/assistantProfile'
import draft from '@/services/assistantProfileDraft.json'

const profile = {
  persona: { slug: 'custom', name: 'Persönlich', prompt: 'Fremde Kontodaten' },
  skills: [],
  revision: 'abc',
}
const config = { baseUrl: 'https://local.example', deviceKey: 'test-only', clientId: 'device' }
beforeEach(() => {
  resetAssistantProfile()
  vi.clearAllMocks()
  mocks.config.mockResolvedValue(config)
})
describe('assistant profile binding and local draft', () => {
  it('contains the confirmed draft and all three conditional skills', () => {
    const parsed = parseAssistantProfile(draft)
    expect(parsed.skills).toHaveLength(3)
    expect(localAssistantProfilePrompt(parsed)).toContain('keine Werkzeug-, Datei- oder Netzwerkfreigaben')
    expect(localAssistantProfilePrompt(parsed)).toContain('Bei Laravel- und PHP-Aufgaben')
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
