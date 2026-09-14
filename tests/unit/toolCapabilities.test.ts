import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import ExecutionSettingsSection from '@/components/settings/ExecutionSettingsSection.vue'
import { capabilityAccess, type ToolCapability } from '@/services/toolCapabilities'

const sensitiveRead: ToolCapability = {
  name: 'os_screen_capture',
  description: 'Screen capture',
  mutating: false,
  requiresApproval: true,
  dataHandling: 'ephemeral',
}
const mutation: ToolCapability = {
  name: 'fs_write',
  description: 'Write a project file',
  mutating: true,
  requiresApproval: true,
  scope: 'project',
  risk: 'critical',
  effects: ['write'],
}

describe('visible capability permissions', () => {
  it('keeps sensitive reading behind approval when automatic writing is enabled', () => {
    expect(capabilityAccess(sensitiveRead, 'act', true, false)).toBe('approval')
    expect(capabilityAccess(mutation, 'act', true, false)).toBe('approval')
    expect(capabilityAccess({ ...mutation, risk: 'low' }, 'act', true, false)).toBe('automatic')
    expect(capabilityAccess(mutation, 'act', false, false)).toBe('approval')
    expect(capabilityAccess(mutation, 'observe', true, false)).toBe('observe_locked')
  })

  it('shows the emergency stop even for unrestricted and read-only tools', () => {
    for (const tool of [sensitiveRead, mutation]) {
      expect(capabilityAccess(tool, 'unrestricted', true, true)).toBe('stopped')
      expect(capabilityAccess(tool, 'unrestricted', false, false)).toBe('automatic')
    }
  })

  it('renders the actual registered tools with separate read and write permissions', async () => {
    const html = await renderToString(
      createSSRApp(ExecutionSettingsSection, {
        autoExecuteMutatingTools: true,
        mode: 'observe',
        tools: [sensitiveRead, mutation],
      })
    )
    expect(html).toContain('2 registrierte Werkzeuge')
    expect(html).toContain('Bildschirm aufnehmen')
    expect(html).toContain('Datei schreiben')
    expect(html).toContain('Einzelbestätigung')
    expect(html).toContain('Im Beobachten gesperrt')
    expect(html).toContain('nicht im Chatarchiv gespeichert')
    expect(html).toContain('type="search"')
    expect(html).toContain('Kategorie und Unterkategorie')
    expect(html).toContain('files/local/write')
    expect(html).toContain('Computer › Bildschirm und Fenster › Lesen und Prüfen')
  })
})
