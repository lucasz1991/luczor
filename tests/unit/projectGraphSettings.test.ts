import { createSSRApp, type SSRContext } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import ProjectSettingsModal from '@/components/ProjectSettingsModal.vue'
import type { RepositoryGraphStatus } from '@/services/repositoryGraph'

async function render(status: RepositoryGraphStatus) {
  const context: SSRContext = {}
  const html = await renderToString(createSSRApp(ProjectSettingsModal, {
    open: true, project: { id: 'test', name: 'Test project' }, workspace: null,
    graphStatus: status, policy: 'deny', initialTab: 'graph',
  }), context)
  return html + Object.values(context.teleports ?? {}).join('')
}

describe('repository graph settings', () => {
  it('renders native Unix seconds as the real index date, not January 1970', async () => {
    const indexedAt = Date.UTC(2026, 8, 18, 12) / 1000
    const html = await render({ status: 'ready', files: 2433, symbols: 28092, edges: 7918, skipped: 320,
      last_indexed_at: indexedAt, lsp: { status: 'error', files: 714, scanned: 0, edges: 0 },
    })
    expect(html).toContain(new Date(indexedAt * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }))
    expect(html).not.toContain('21.01.70')
    expect(html).toContain('Analyse fehlgeschlagen')
    expect(html).toContain('0/714 Dateien')
  })

  it('does not invent an index date before the first completed pass', async () => {
    const html = await render({ status: 'unindexed', files: 0, symbols: 0, edges: 0, skipped: 0 })
    expect(html).toContain('indexiert —')
  })
})
