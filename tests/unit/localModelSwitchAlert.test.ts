import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import Alert from '@/components/ai/LocalModelSwitchAlert.vue'
import type { ModelSwitchState } from '@/services/inference/modelSwitch'

afterEach(() => vi.useRealTimers())
const render = (phase: ModelSwitchState['phase']) => {
  vi.useFakeTimers()
  return renderToString(
    createSSRApp({
      render: () =>
        h(Alert, {
          state: {
            revision: 1,
            phase,
            selectedModelId: 'small',
            previousModelId: 'large',
            activeModelId: phase === 'ready' ? 'small' : undefined,
          },
          modelNames: { small: 'Laptop-Modell', large: 'Desktop-Modell' },
        }),
    })
  )
}

describe('model switch notification', () => {
  it('explains waiting for whole jobs without allowing the pending notification to be dismissed', async () => {
    const html = await render('waiting')
    expect(html).toContain('Modellwechsel vorgemerkt')
    expect(html).toContain('Laufende Aufträge werden abgeschlossen')
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('Anzeige schließen')
  })
  it('names the old model and describes freeing RAM/GPU before readiness', async () => {
    const html = await render('unloading')
    expect(html).toContain('Desktop-Modell')
    expect(html).toContain('RAM/GPU freigeben')
    expect(html).not.toContain('Lokales Modell ist bereit')
  })
  it('shows preparation in chats and reserves ready for the completed check', async () => {
    expect(await render('loading')).toContain('Neue Chats zeigen „Modell vorbereiten“')
    const html = await render('ready')
    expect(html).toContain('Lokales Modell ist bereit')
    expect(html).toContain('aria-busy="false"')
    expect(html).toContain('Anzeige schließen')
  })
  it('offers an explicit retry and a safe diagnostic entry point on failure', async () => {
    const html = await render('failed')
    expect(html).toContain('Erneut vorbereiten')
    expect(html).toContain('Systemstatus → Lokales Modell')
    expect(html).not.toContain('RAM/GPU freigeben')
  })
})
