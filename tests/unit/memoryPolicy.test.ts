import { describe, expect, it } from 'vitest'
import { containsSensitiveMemoryData, planMemoryWrite } from '@/services/memory/luczorMemory'
import { projectsForSync } from '@/services/api/sync'
import { canShareRepositoryContext, shouldUseRepositoryGraph } from '@/services/repositoryGraph'

describe('desktop memory and repository privacy policy', () => {
  it('keeps ordinary chat and assistant output as local candidates', () => {
    expect(
      planMemoryWrite({ content: 'Wie funktioniert das?', source: 'user', writeIntent: 'automatic' })
    ).toMatchObject({
      status: 'candidate',
      localOnly: true,
      retention: 'session',
    })
    expect(planMemoryWrite({ content: 'Das ist die Antwort.', source: 'assistant' })).toMatchObject({
      status: 'candidate',
      localOnly: true,
    })
    expect(
      planMemoryWrite({ content: 'Warum stürzt es immer ab?', source: 'user', writeIntent: 'automatic' })
    ).toMatchObject({
      status: 'candidate',
      localOnly: true,
      writeIntent: 'automatic',
    })
  })

  it('allows an explicit safe memory but never secrets or repository facts', () => {
    expect(planMemoryWrite({ content: 'Merke dir: Antworte auf Deutsch.', source: 'user' })).toMatchObject({
      status: 'active',
      localOnly: false,
      writeIntent: 'explicit',
    })
    expect(planMemoryWrite({ content: 'Merke dir meinen API key abc', source: 'user' })).toMatchObject({
      sensitivity: 'secret',
      localOnly: true,
    })
    expect(planMemoryWrite({ content: 'ghp_abcdefghijklmnopqrstuvwxyz123456', source: 'user' })).toMatchObject({
      sensitivity: 'secret',
      localOnly: true,
    })
    expect(planMemoryWrite({ content: 'Klasse Foo liegt in src/Foo.php', source: 'repository_graph' })).toMatchObject({
      localOnly: true,
      reason: 'repository_local_only',
    })
  })

  it('keeps secrets in every persisted or synchronized metadata field local only', () => {
    const safe = { content: 'Merke dir diese Einstellung.', source: 'user' as const, writeIntent: 'explicit' as const }
    for (const metadata of [
      { sourceRef: 'https://build-user:super-password@example.test/result/42' },
      { meta: { api_key: 'github_pat_abcdefghijklmnopqrstuvwxyz123456' } },
      { provenance: { Authorization: 'Bearer eyJabcdefghijk.eyJabcdefghijkl.abcdefghijklmnop' } },
      { tags: ['release', 'xoxb-12345678901234567890'] },
    ]) {
      expect(planMemoryWrite({ ...safe, ...metadata })).toMatchObject({
        sensitivity: 'secret',
        localOnly: true,
        visibility: 'private',
      })
    }

    // A caller may not override an actual DLP finding by declaring the value normal.
    expect(
      planMemoryWrite({
        ...safe,
        sensitivity: 'normal',
        meta: { api_key: 'github_pat_abcdefghijklmnopqrstuvwxyz123456' },
      })
    ).toMatchObject({ sensitivity: 'secret', localOnly: true })
  })

  it('detects opaque secrets by canonical camelCase and snake_case key names', () => {
    for (const key of ['clientSecret', 'passwordHash', 'dbPassword', 'secret_value']) {
      const payload = { nested: { [key]: 'opaque-value-without-a-secret-pattern' } }
      expect(containsSensitiveMemoryData(payload)).toBe(true)
      expect(
        planMemoryWrite({
          content: 'Merke dir diese Einstellung.',
          source: 'user',
          writeIntent: 'explicit',
          meta: payload,
        })
      ).toMatchObject({ sensitivity: 'secret', localOnly: true, visibility: 'private' })
    }
  })

  it('fails closed for cyclic, deeply nested, oversized and overpopulated metadata', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    let deep: Record<string, unknown> = { value: 'safe' }
    for (let index = 0; index < 12; index += 1) deep = { nested: deep }

    expect(containsSensitiveMemoryData(cyclic)).toBe(true)
    expect(containsSensitiveMemoryData(deep)).toBe(true)
    expect(containsSensitiveMemoryData({ value: 'x'.repeat(65_537) })).toBe(true)
    expect(containsSensitiveMemoryData(Array.from({ length: 1_100 }, () => 'safe'))).toBe(true)
    expect(containsSensitiveMemoryData({ nested: { language: 'de', style: 'short' } })).toBe(false)
  })

  it('enforces the traversal budget in UTF-8 bytes instead of UTF-16 code units', () => {
    expect(containsSensitiveMemoryData({ nested: '漢'.repeat(40_000) })).toBe(true)
  })

  it('never includes local repository fields in project sync payloads', () => {
    const [project] = projectsForSync([
      {
        id: 'p1',
        name: 'Luczor',
        summary: 'Test',
        repository: { rootPath: 'E:\\private\\luczor' },
        rootPath: 'E:\\private\\luczor',
        localGraph: { repositoryId: 'secret' },
      },
    ])
    expect(project).toMatchObject({ id: 'p1', name: 'Luczor', summary: 'Test' })
    expect(project).not.toHaveProperty('repository')
    expect(project).not.toHaveProperty('rootPath')
    expect(project).not.toHaveProperty('localGraph')
  })

  it('routes only code and architecture tasks to the repository graph', () => {
    expect(shouldUseRepositoryGraph('coding.fix_bug')).toBe(true)
    expect(shouldUseRepositoryGraph('planning.architecture')).toBe(true)
    expect(shouldUseRepositoryGraph('chat.general')).toBe(false)
  })

  it('requires a fresh per-turn approval in ask mode', () => {
    expect(canShareRepositoryContext('deny', true)).toBe(false)
    expect(canShareRepositoryContext('ask', false)).toBe(false)
    expect(canShareRepositoryContext('ask', true)).toBe(true)
    expect(canShareRepositoryContext('allow_selected', false)).toBe(true)
  })
})
