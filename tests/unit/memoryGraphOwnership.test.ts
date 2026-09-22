import { describe, expect, it } from 'vitest'
import { parse } from '@vue/compiler-sfc'
import appSource from '@/App.vue?raw'
import pageSource from '@/features/memory/MemoryExplorerPage.vue?raw'
import settingsSource from '@/components/ProjectSettingsModal.vue?raw'
import { normalizeMemoryGraphDisplay } from '@/features/memory/graphDisplay'

describe('knowledge renderer ownership', () => {
  it('mounts the render layer only inside the conditionally mounted knowledge page', () => {
    const app = parse(appSource).descriptor
    const page = parse(pageSource).descriptor
    expect(app.template!.content).not.toContain('<MemoryGraphBackdrop')
    expect(app.template!.content).toMatch(/<MemoryExplorerPage\s+v-if="showMemoryExplorer"/)
    expect(page.template!.content).toContain('<MemoryGraphBackdrop />')
    expect(page.scriptSetup!.content).toContain('data.stopListening()')
  })

  it('ignores the legacy ambient preference and no longer offers a background toggle', () => {
    expect(normalizeMemoryGraphDisplay({ ambientBackdrop: true })).not.toHaveProperty('ambientBackdrop')
    expect(settingsSource).not.toContain("setDisplay('ambientBackdrop'")
  })
})
