import { createSSRApp, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it, vi } from 'vitest'
import AppearanceSettingsSection from '@/components/settings/AppearanceSettingsSection.vue'
import AccountConnection from '@/components/settings/AccountConnection.vue'
import ChatSettingsSection from '@/components/settings/ChatSettingsSection.vue'
import ExecutionSettingsSection from '@/components/settings/ExecutionSettingsSection.vue'
import VoiceSettingsSection from '@/components/settings/VoiceSettingsSection.vue'
import { VOICE_DEFAULTS } from '@/services/voice/localVoice'

async function render(component: Component, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(component, props))
}

function emittedEvents(component: Component): string[] {
  const emits = (component as Component & { emits?: string[] | Record<string, unknown> }).emits
  return Array.isArray(emits) ? emits : Object.keys(emits ?? {})
}

describe('settings section contracts', () => {
  it('explains automatic browser adoption and exposes a current-device logout action', async () => {
    const html = await render(AccountConnection, {
      baseUrl: 'https://luczor.example.test',
      clientId: 'desktop-1',
      connected: true,
    })

    expect(html).toContain('Konto wechseln')
    expect(html).toContain('Abmelden')
    expect(html).toContain('Auf diesem Gerät angemeldet.')
    expect(emittedEvents(AccountConnection)).toEqual(expect.arrayContaining(['connected', 'logout']))
  })

  it('offers model and context preparation enabled by default with independent controls', async () => {
    const html = await render(ExecutionSettingsSection, { autoExecuteMutatingTools: false })
    expect(html).toContain('Lokales Modell bereithalten')
    expect(html).toContain('Projektkontext vorab vorbereiten')
    expect(emittedEvents(ExecutionSettingsSection)).toEqual(
      expect.arrayContaining(['update:backgroundModelPreparation', 'update:backgroundContextPreparation'])
    )
    const disabled = await render(ExecutionSettingsSection, {
      autoExecuteMutatingTools: false,
      backgroundModelPreparation: false,
      backgroundContextPreparation: false,
    })
    expect(disabled).not.toContain('aria-pressed="true"')
  })
  it('renders execution state and declares its typed update event', async () => {
    const html = await render(ExecutionSettingsSection, { autoExecuteMutatingTools: true })

    expect(html).toContain('Ausführung &amp; Freigaben')
    expect(html).toMatch(/class="[^"]*\bis-on\b[^"]*\blz-switch\b|class="[^"]*\blz-switch\b[^"]*\bis-on\b/)
    expect(html).toContain('aria-pressed="true"')
    expect(emittedEvents(ExecutionSettingsSection)).toContain('update:autoExecuteMutatingTools')
  })

  it('explains server TTS authentication and keeps local STT controls driven by props', async () => {
    const testSpeech = vi.fn(async () => 'completed' as const)
    const html = await render(VoiceSettingsSection, {
      deviceKey: '',
      voiceMode: 'wakeword',
      wakeWord: 'luczor',
      endPhrase: VOICE_DEFAULTS.endPhrase,
      continuousSilenceMs: VOICE_DEFAULTS.continuousSilenceMs,
      autoSubmit: VOICE_DEFAULTS.autoSubmit,
      sttLanguage: 'de',
      testSpeech,
    })

    expect(html).toContain('Device-Key für die Server-Sprachausgabe fehlt')
    expect(html).toContain('Die Spracheingabe läuft lokal mit whisper.cpp.')
    expect(html).toContain('FollowFlow und RailTime')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Sprachausgabe testen<\/button>/)
    expect(html).toContain('value="wakeword" selected')
    expect(html).toContain('value="luczor"')
    expect(html).toContain('value="luczor stopp"')
    expect(html).toContain('Auch nach Sprechpause automatisch senden')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('Close-Word sendet unabhängig von diesem Schalter automatisch')
    expect(emittedEvents(VoiceSettingsSection)).toEqual(
      expect.arrayContaining([
        'update:voiceMode',
        'update:wakeWord',
        'update:endPhrase',
        'update:continuousSilenceMs',
        'update:autoSubmit',
        'update:sttLanguage',
        'openServer',
      ])
    )
    expect(testSpeech).not.toHaveBeenCalled()
  })

  it('renders configurable dictation silence, close phrase and explicit automatic submission', async () => {
    const html = await render(VoiceSettingsSection, {
      deviceKey: 'test-device-key',
      voiceMode: 'continuous',
      wakeWord: 'jarvis start',
      endPhrase: 'jarvis ende',
      continuousSilenceMs: 8000,
      autoSubmit: true,
      sttLanguage: 'de',
      testSpeech: vi.fn(async () => 'completed' as const),
    })
    expect(html).toContain('value="jarvis ende"')
    expect(html).toContain('value="8"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('Sendet den fertigen Text ohne weiteren Klick')
    expect(html).toContain('min="1" max="30"')
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

  it('uses the shared save action for a parent-owned model draft', async () => {
    const html = await render(ChatSettingsSection, {
      autoSpeech: false,
      autoSpeechMode: 'off',
      historyTokenBudget: 2400,
      modelUsage: {
        localModelId: 'local-tier-light',
        externalEnabled: true,
        chatRouteMode: 'auto',
      },
    })
    expect(html).not.toContain('Modellnutzung speichern')
    expect(html).toContain('unten im Einstellungsfenster')
    // The route mode is the only team control left; there is no separate team picker.
    expect(html).toMatch(/<option[^>]*value="auto"[^>]*selected/)
    expect(html).not.toContain('Agententeam')
    expect(html).toContain('local-tier-light')
    expect(emittedEvents(ChatSettingsSection)).toContain('update:modelUsage')
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
