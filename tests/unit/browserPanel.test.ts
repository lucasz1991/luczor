import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import BrowserPanel from '@/components/browser/BrowserPanel.vue'
import { browserPanel } from '@/services/browserPanel'

describe('browser panel presentation', () => {
  it('keeps an accessible restoration rail when collapsed', async () => {
    browserPanel.expanded = false
    const html = await renderToString(createSSRApp(BrowserPanel, { projectId: 'project' }))
    expect(html).toContain('aria-label="Browser ausklappen"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('is-collapsed')
  })
  it('explains desktop availability and keeps collapse distinct from ending a session', async () => {
    browserPanel.expanded = true
    const html = await renderToString(createSSRApp(BrowserPanel, { projectId: 'project' }))
    expect(html).toContain('Browser einklappen · Sitzung behalten')
    expect(html).toContain('Luczor-Desktop-App')
    expect(html).toContain('aria-label="Browser-Adresse"')
    expect(html).not.toContain('<iframe')
  })
})
