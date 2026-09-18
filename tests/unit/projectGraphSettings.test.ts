import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import ProjectSettingsModal from '@/components/ProjectSettingsModal.vue'
import type { RepositoryGraphStatus } from '@/services/repositoryGraph'
import { repositoryLspDetail } from '@/services/repositoryLspStatus'

async function render(status: RepositoryGraphStatus) {
  const context: { teleports?: Record<string, string> } = {}
  const html = await renderToString(
    createSSRApp(ProjectSettingsModal, {
      open: true,
      project: { id: 'test', name: 'Test project' },
      workspace: null,
      graphStatus: status,
      policy: 'deny',
      initialTab: 'graph',
    }),
    context
  )
  return html + Object.values(context.teleports ?? {}).join('')
}

describe('repository graph settings', () => {
  it('renders native Unix seconds as the real index date, not January 1970', async () => {
    const indexedAt = Date.UTC(2026, 8, 18, 12) / 1000
    const html = await render({
      status: 'ready',
      files: 2433,
      symbols: 28092,
      edges: 7918,
      skipped: 320,
      last_indexed_at: indexedAt,
      lsp: { status: 'error', files: 714, scanned: 0, edges: 0 },
    })
    expect(html).toContain(
      new Date(indexedAt * 1000).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
    )
    expect(html).not.toContain('21.01.70')
    expect(html).toContain('Analyse fehlgeschlagen')
    expect(html).toContain('0/714 Dateien')
  })

  it('does not invent an index date before the first completed pass', async () => {
    const html = await render({ status: 'unindexed', files: 0, symbols: 0, edges: 0, skipped: 0 })
    expect(html).toContain('indexiert —')
  })

  it('renders safe LSP phase and failure guidance independently of a ready base index', async () => {
    const html = await render({
      status: 'ready',
      files: 12,
      symbols: 20,
      edges: 15,
      skipped: 0,
      lsp: {
        status: 'partial',
        files: 12,
        scanned: 11,
        edges: 4,
        failed_files: 1,
        reason: 'lsp_request_timeout',
        phase: 'symbols',
      },
    })
    expect(html).toContain('Symbole lesen')
    expect(html).toContain('Eine Datei benötigte zu lange')
    expect(html).toContain('1 Dateien ohne abgeschlossene Analyse')
    expect(html).toContain('getrennte Analysen')
    expect(
      repositoryLspDetail({
        status: 'error',
        files: 1,
        scanned: 0,
        edges: 0,
        reason: 'PRIVATE_PATH SECRET',
        phase: 'PRIVATE_SOURCE',
      })
    ).not.toMatch(/PRIVATE|SECRET/)
  })
})
