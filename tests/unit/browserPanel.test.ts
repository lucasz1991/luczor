import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import BrowserPanel from '@/components/browser/BrowserPanel.vue'
import { browserPanel } from '@/services/browserPanel'

describe('browser panel presentation', () => {
  it('fully removes the workspace row when the browser is collapsed', async () => {
    browserPanel.expanded = false
    const html = await renderToString(createSSRApp(BrowserPanel, { projectId: 'project' }))
    expect(html).not.toContain('id="browser-panel"')
  })
  it('uses a keyboard-resizable 1600 by 900 desktop workspace without an iframe', async () => {
    browserPanel.expanded = true
    const html = await renderToString(createSSRApp(BrowserPanel, { projectId: 'project' }))
    expect(html).toContain('Browser vollständig einklappen · Sitzung behalten')
    expect(html).toContain('Desktop-Ansicht')
    expect(html).toContain('1600 × 900')
    expect(html).toContain('Luczor-Desktop-App')
    expect(html).toContain('aria-label="Browser-Adresse"')
    expect(html).toContain('aria-label="Browser-Höhe anpassen"')
    expect(html).toContain('aria-orientation="horizontal"')
    expect(html).not.toContain('<iframe')
  })
})
