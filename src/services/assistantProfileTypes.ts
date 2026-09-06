export type AssistantProfile = {
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
