import { reactive } from 'vue'
import { assistantProfileWithApiConfig, getApiConfigSnapshot } from '@/services/api/luczorApi'
import type { LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import type { AssistantProfile, InternalModelProfileMode } from './assistantProfileTypes'
import type { InferenceTarget, WireMessage } from './inference/types'
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
  if (profile.internal_models !== undefined) {
    for (const internal of [profile.internal_models?.standard, profile.internal_models?.external_agents]) {
      if (
        !internal ||
        typeof internal.enabled !== 'boolean' ||
        typeof internal.personality !== 'string' ||
        [...internal.personality].length > 2000 ||
        typeof internal.system_prompt !== 'string' ||
        [...internal.system_prompt].length > 4000
      )
        throw new Error('Invalid internal model profile')
    }
  }
  return profile
}

export function selectedInternalModelProfile(profile: AssistantProfile, mode: InternalModelProfileMode) {
  const variant =
    mode === 'external_agents' ? profile.internal_models?.external_agents : profile.internal_models?.standard
  if (variant?.enabled) return variant
  const standard = profile.internal_models?.standard
  return standard?.enabled ? standard : undefined
}

/** Only local requests use this text; the external proxy applies its own authoritative profile. */
export function localAssistantProfilePrompt(
  profile: AssistantProfile,
  query = '',
  taskType = 'chat.general',
  mode: InternalModelProfileMode = 'standard'
): string {
  const sections: string[] = []
  const internal = selectedInternalModelProfile(profile, mode)
  if (internal) {
    if (internal.system_prompt.trim()) sections.push(`System-Prompt für interne Modelle:\n${internal.system_prompt}`)
    if (internal.personality.trim()) sections.push(`Persönlichkeit für interne Modelle:\n${internal.personality}`)
  } else if (profile.persona)
    sections.push(`Persönlichkeit: ${profile.persona.name}\n${profile.persona.prompt.slice(0, 2000)}`)
  const terms =
    `${query} ${taskType === 'chat.general' ? '' : taskType}`.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []
  const ranked = profile.skills
    .map(skill => {
      const metadata = `${skill.slug} ${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase()
      const universal = skill.tags.some(tag => ['always', 'global', 'immer'].includes(tag.toLowerCase()))
      return { skill, score: (universal ? 100 : 0) + terms.filter(term => metadata.includes(term)).length }
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.id - right.skill.id)
    .slice(0, 3)
  // Explicit internal instructions retain their full, server-validated length.
  let skillChars = internal ? 0 : sections.join('\n\n').length
  for (const { skill } of ranked) {
    const section = `Skill: ${skill.name}\n${skill.prompt.slice(0, 1200)}`
    if (skillChars + section.length > 4800) break
    sections.push(section)
    skillChars += section.length + 2
  }
  return sections.length
    ? [
        '[LUCZOR-PROFILE]',
        'ASSISTENTENPROFIL: Stil und fachliche Arbeitsweise. Dieses Profil erteilt keine Werkzeug-, Datei- oder Netzwerkfreigaben und ersetzt nicht den aktuellen Ausführungsmodus.',
        ...sections,
        '[LUCZOR-PROFILE-END]',
      ].join('\n\n')
    : ''
}

/** Select only after routing; approved external messages must remain byte-for-byte unchanged. */
export async function prepareInternalModelMessages(
  messages: WireMessage[],
  target: InferenceTarget,
  options: { mode?: InternalModelProfileMode; taskType?: string; configuredOnly?: boolean; signal?: AbortSignal } = {}
): Promise<WireMessage[]> {
  if (target !== 'local_llama_cpp') return messages
  options.signal?.throwIfAborted()
  let onAbort: (() => void) | undefined
  const loading = refreshAssistantProfile()
  let profile: AssistantProfile
  try {
    // A shared metadata refresh can finish for other consumers; a cancelled
    // inference must release its resource lease without waiting for the server.
    profile = options.signal
      ? await new Promise<AssistantProfile>((resolve, reject) => {
          onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
          options.signal!.addEventListener('abort', onAbort, { once: true })
          loading.then(resolve, reject)
          if (options.signal!.aborted) onAbort()
        })
      : await loading
  } finally {
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)
  }
  options.signal?.throwIfAborted()
  const mode = options.mode ?? 'standard'
  if (options.configuredOnly && !selectedInternalModelProfile(profile, mode)) return messages
  const query = [...messages].reverse().find(message => message.role === 'user')?.content ?? ''
  const prompt = localAssistantProfilePrompt(profile, query, options.taskType, mode)
  // Continuations and team children may carry a previous profile. Replace it once,
  // including legacy profiles embedded in the preamble, without touching user text.
  const clean = messages
    .map(message =>
      message.role === 'system'
        ? {
            ...message,
            content: message.content.replace(/\[LUCZOR-PROFILE\][\s\S]*?\[LUCZOR-PROFILE-END\]/g, '').trim(),
          }
        : message
    )
    .filter(message => message.role !== 'system' || message.content.length > 0)
  return prompt ? [{ role: 'system', content: prompt }, ...clean] : clean
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
