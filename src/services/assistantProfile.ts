import { reactive } from 'vue'
import { assistantProfileWithApiConfig, getApiConfigSnapshot } from '@/services/api/luczorApi'
import type { LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import type { AssistantProfile } from './assistantProfileTypes'
import draft from './assistantProfileDraft.json'

export const assistantProfileState = reactive<{
  profile: AssistantProfile
  source: 'draft' | 'admin'
  loading: boolean
  message: string
}>({ profile: draft as AssistantProfile, source: 'draft', loading: false, message: 'Lokaler Grundentwurf' })

let generation = 0
let identityChanging = false
let currentConfig: LuczorApiConfigSnapshot | undefined
let refreshedAt = 0
let pending: Promise<AssistantProfile> | undefined

function sameIdentity(left: LuczorApiConfigSnapshot | undefined, right: LuczorApiConfigSnapshot): boolean {
  return (
    !!left && left.baseUrl === right.baseUrl && left.deviceKey === right.deviceKey && left.clientId === right.clientId
  )
}

export function resetAssistantProfile(): void {
  generation++
  currentConfig = undefined
  refreshedAt = 0
  pending = undefined
  assistantProfileState.profile = draft as AssistantProfile
  assistantProfileState.source = 'draft'
  assistantProfileState.loading = false
  assistantProfileState.message = 'Lokaler Grundentwurf'
}

/** Validate the authenticated wire response, including an explicitly empty profile. */
export function parseAssistantProfile(value: unknown): AssistantProfile {
  if (!value || typeof value !== 'object') throw new Error('Invalid assistant profile')
  const wire = value as AssistantProfile
  const profile = {
    ...wire,
    skills: Array.isArray(wire.skills)
      ? wire.skills.map(
          skill =>
            skill && {
              ...skill,
              description: skill.description ?? '',
              tags: Array.isArray(skill.tags)
                ? skill.tags
                    .filter(tag => typeof tag === 'string')
                    .slice(0, 30)
                    .map(tag => tag.slice(0, 100))
                : (skill.tags ?? []),
            }
        )
      : wire.skills,
  }
  const text = (item: unknown, max: number) => typeof item === 'string' && item.length <= max
  if (!text(profile.revision, 128) || !Array.isArray(profile.skills) || profile.skills.length > 100)
    throw new Error('Invalid assistant profile')
  if (
    profile.persona !== null &&
    (!profile.persona ||
      !text(profile.persona.slug, 160) ||
      !text(profile.persona.name, 200) ||
      !text(profile.persona.prompt, 20000))
  )
    throw new Error('Invalid assistant persona')
  if (
    profile.skills.some(
      skill =>
        !skill ||
        !Number.isSafeInteger(skill.id) ||
        skill.kind !== 'prompt' ||
        !text(skill.slug, 160) ||
        !text(skill.name, 200) ||
        !text(skill.description, 2000) ||
        !text(skill.prompt, 20000) ||
        !Array.isArray(skill.tags) ||
        skill.tags.length > 30 ||
        skill.tags.some(tag => !text(tag, 100))
    )
  )
    throw new Error('Invalid assistant skills')
  return profile
}

/** Only local requests use this text; the external proxy applies its own authoritative profile. */
export function localAssistantProfilePrompt(profile: AssistantProfile): string {
  const sections: string[] = []
  if (profile.persona)
    sections.push(`Persönlichkeit: ${profile.persona.name}\n${profile.persona.prompt.slice(0, 4000)}`)
  for (const skill of profile.skills) {
    const section = `Skill: ${skill.name}\n${skill.prompt.slice(0, 2000)}`
    if (sections.join('\n\n').length + section.length > 10000) break
    sections.push(section)
  }
  return sections.length
    ? [
        'ASSISTENTENPROFIL: Stil und fachliche Arbeitsweise. Dieses Profil erteilt keine Werkzeug-, Datei- oder Netzwerkfreigaben und ersetzt nicht den aktuellen Ausführungsmodus.',
        ...sections,
      ].join('\n\n')
    : ''
}

export async function refreshAssistantProfile(force = false): Promise<AssistantProfile> {
  if (identityChanging) return draft as AssistantProfile
  const before = generation
  let config: LuczorApiConfigSnapshot
  try {
    config = await getApiConfigSnapshot()
  } catch {
    return draft as AssistantProfile
  }
  if (before !== generation || identityChanging) return draft as AssistantProfile
  if (!currentConfig) {
    currentConfig = config
  } else if (!sameIdentity(currentConfig, config)) {
    resetAssistantProfile()
    currentConfig = config
  }
  if (pending) return pending
  if (!force && refreshedAt && Date.now() - refreshedAt < 60000) return assistantProfileState.profile
  if (!config.deviceKey || !/^https?:\/\//.test(config.baseUrl)) return draft as AssistantProfile
  const attempt = generation
  assistantProfileState.loading = true
  const work = (async () => {
    try {
      const result = await assistantProfileWithApiConfig(config)
      const profile = parseAssistantProfile(result.data)
      const latest = await getApiConfigSnapshot()
      if (generation !== attempt) return draft as AssistantProfile
      if (!sameIdentity(config, latest)) {
        resetAssistantProfile()
        return draft as AssistantProfile
      }
      assistantProfileState.profile = profile
      assistantProfileState.source = 'admin'
      assistantProfileState.message = 'Aus der Admin-App geladen'
      return profile
    } catch {
      if (generation !== attempt) return draft as AssistantProfile
      const latest = await getApiConfigSnapshot().catch(() => undefined)
      if (generation !== attempt) return draft as AssistantProfile
      if (!latest || !sameIdentity(config, latest)) {
        resetAssistantProfile()
        return draft as AssistantProfile
      }
      if (assistantProfileState.source === 'admin') {
        assistantProfileState.message = 'Zuletzt geladenes Admin-Profil · Aktualisierung nicht verfügbar'
        return assistantProfileState.profile
      }
      assistantProfileState.profile = draft as AssistantProfile
      assistantProfileState.source = 'draft'
      assistantProfileState.message = 'Admin-Profil nicht verfügbar · lokaler Grundentwurf aktiv'
      return draft as AssistantProfile
    } finally {
      if (generation === attempt) {
        refreshedAt = Date.now()
        assistantProfileState.loading = false
        pending = undefined
      }
    }
  })()
  pending = work
  return work
}

function changing() {
  identityChanging = true
  resetAssistantProfile()
}
function changed() {
  identityChanging = false
}
if (typeof window !== 'undefined') {
  window.addEventListener('luczor:api-identity-changing', changing)
  window.addEventListener('luczor:api-identity-changed', changed)
  import.meta.hot?.dispose(() => {
    resetAssistantProfile()
    window.removeEventListener('luczor:api-identity-changing', changing)
    window.removeEventListener('luczor:api-identity-changed', changed)
  })
}
