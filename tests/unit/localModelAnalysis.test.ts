import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import LocalModelAnalysis from '@/components/LocalModelAnalysis.vue'
import { localModelDiagnostics } from '@/services/inference/localModelDiagnostics'

beforeEach(() => {
  localModelDiagnostics.clear()
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
})
afterEach(() => {
  localModelDiagnostics.clear()
  vi.unstubAllGlobals()
})

const render = () => renderToString(createSSRApp(LocalModelAnalysis))

describe('local model failure analysis', () => {
  it('renders the model, failed stage, HTTP status, parameter and known token counts as a readable report', async () => {
    localModelDiagnostics
      .begin('Laptop Linux x64 · Qwen3-4B', [{ role: 'system', content: 'hidden prompt' }])
      .fail(false, {
        schemaVersion: 1,
        stage: 'generation',
        httpStatus: 400,
        code: 'runtime_tool_contract_rejected',
        parameter: 'tools',
        reason: 'tool_contract',
        inputTokens: 1234,
        contextTokens: 8192,
      })
    const html = await render()
    expect(html).toContain('Laptop Linux x64 · Qwen3-4B')
    expect(html).toContain('aria-label="Fehlerdiagnose"')
    expect(html).toContain('Generierung')
    expect(html).toContain('HTTP-Status')
    expect(html).toContain('400')
    expect(html).toContain('runtime_tool_contract_rejected')
    expect(html).toContain('tools')
    expect(html).toContain('1.234')
    expect(html).toContain('8.192')
    expect(html).toContain('nicht ermittelt')
    expect(html).toContain('Diagnose kopieren')
    expect(html).not.toContain('hidden prompt')
  })

  it('shows unavailable evidence explicitly without inventing an HTTP code or context error', async () => {
    localModelDiagnostics.begin('local', []).fail(false, new Error('private raw response'))
    const html = await render()
    expect(html).toContain('keine geprüften Fehlerdetails')
    expect(html).toContain('nicht ermittelt')
    expect(html).not.toContain('private raw response')
    expect(html).not.toContain('HTTP 400')
    expect(html).not.toContain('runtime_context_exceeded')
  })

  it('omits the copy action when the browser has no clipboard API', async () => {
    vi.stubGlobal('navigator', {})
    localModelDiagnostics.begin('local', []).fail(false)
    expect(await render()).not.toContain('Diagnose kopieren')
  })

  it('does not describe an intentional cancellation as an HTTP failure and clears every diagnostic', async () => {
    localModelDiagnostics.begin('local', []).fail(true, {
      schemaVersion: 1,
      stage: 'generation',
      httpStatus: 400,
      code: 'runtime_tool_contract_rejected',
      parameter: 'tools',
      reason: 'tool_contract',
    })
    const cancelled = await render()
    expect(cancelled).toContain('Abgebrochen')
    expect(cancelled).not.toContain('aria-label="Fehlerdiagnose"')
    expect(cancelled).not.toContain('HTTP 400')
    localModelDiagnostics.clear()
    const cleared = await render()
    expect(cleared).toContain('Noch keine Inferenzmesswerte empfangen')
    expect(cleared).not.toContain('Fehlerdiagnose')
  })
})
