import { createSSRApp, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import AppearanceSettingsSection from '@/components/settings/AppearanceSettingsSection.vue'
import ChatSettingsSection from '@/components/settings/ChatSettingsSection.vue'
import ExecutionSettingsSection from '@/components/settings/ExecutionSettingsSection.vue'
import VoiceSettingsSection from '@/components/settings/VoiceSettingsSection.vue'

async function render(component: Component, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(component, props))
}

function emittedEvents(component: Component): string[] {
  const emits = (component as Component & { emits?: string[] | Record<string, unknown> }).emits
  return Array.isArray(emits) ? emits : Object.keys(emits ?? {})
}

describe('settings section contracts', () => {
  it('renders execution state and declares its typed update event', async () => {
    const html = await render(ExecutionSettingsSection, { autoExecuteMutatingTools: true })

    expect(html).toContain('Ausführung &amp; Freigaben')
    expect(html).toMatch(/class="[^"]*\bis-on\b[^"]*\blz-switch\b|class="[^"]*\blz-switch\b[^"]*\bis-on\b/)
    expect(html).toContain('aria-pressed="true"')
    expect(emittedEvents(ExecutionSettingsSection)).toContain('update:autoExecuteMutatingTools')
  })

  it('keeps the Voice warning and model event surface driven by props', async () => {
    const html = await render(VoiceSettingsSection, {
      deviceKey: '',
      voiceMode: 'wakeword',
      wakeWord: 'luczor',
      sttLanguage: 'de',
    })

    expect(html).toContain('Device-Key für die erste Voice-Installation fehlt')
    expect(html).toContain('value="wakeword" selected')
    expect(html).toContain('value="luczor"')
    expect(emittedEvents(VoiceSettingsSection)).toEqual(
      expect.arrayContaining(['update:voiceMode', 'update:wakeWord', 'update:sttLanguage', 'openServer'])
    )
  })

  it('renders the Chat controls without owning persistence', async () => {
    const html = await render(ChatSettingsSection, {
      autoSpeech: true,
      autoSpeechMode: 'assistant_only',
      historyTokenBudget: 2400,
    })

    expect(html).toMatch(/class="[^"]*\bis-on\b[^"]*\blz-switch\b|class="[^"]*\blz-switch\b[^"]*\bis-on\b/)
    expect(html).toContain('2400 Tokens')
    expect(emittedEvents(ChatSettingsSection)).toEqual(
      expect.arrayContaining(['update:autoSpeech', 'update:autoSpeechMode', 'update:historyTokenBudget', 'reset'])
    )
  })

  it('renders Appearance values and exposes only update events', async () => {
    const html = await render(AppearanceSettingsSection, {
      assistantName: 'Luczor',
      accent: 'violet',
      hudPosition: 'br',
      uiScale: 1.25,
      hudVisible: true,
      showGrid: true,
      reduceMotion: false,
    })

    expect(html).toContain('value="Luczor"')
    expect(html).toContain('125%')
    expect(html).toMatch(/class="[^"]*\bis-active\b[^"]*\blz-swatch\b|class="[^"]*\blz-swatch\b[^"]*\bis-active\b/)
    expect(emittedEvents(AppearanceSettingsSection)).toEqual(
      expect.arrayContaining([
        'update:assistantName',
        'update:accent',
        'update:hudPosition',
        'update:uiScale',
        'update:hudVisible',
        'update:showGrid',
        'update:reduceMotion',
      ])
    )
  })
})
