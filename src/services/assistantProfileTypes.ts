export type InternalModelProfileMode = 'standard' | 'external_agents'

export type InternalModelProfile = {
  enabled: boolean
  personality: string
  system_prompt: string
}

export type AssistantProfile = {
  /** Absent on older servers. These instructions never belong to an external provider packet. */
  internal_models?: Record<InternalModelProfileMode, InternalModelProfile>
  persona: { slug: string; name: string; prompt: string } | null
  skills: {
    id: number
    slug: string
    name: string
    description: string
    kind: 'prompt'
    prompt: string
    tags: string[]
  }[]
  revision: string
}
