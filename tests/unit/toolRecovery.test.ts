import { describe, expect, it } from 'vitest'
import { ToolRecoveryGuard } from '@/services/tools/toolRecovery'

describe('tool failure recovery', () => {
  it('restores a browser path only after an actual successful cleanup, not an empty close or status read', () => {
    const guard = new ToolRecoveryGuard()
    for (let index = 0; index < 3; index++) {
      guard.record(
        'browser_open',
        { allowed_hosts: [`guess-${index}.test`] },
        { ok: false, error: 'browser_session_hosts_changed' }
      )
    }
    expect(guard.canOffer('browser_open')).toBe(false)
    expect(guard.canOffer('browser_close')).toBe(true)
    guard.record('browser_close', {}, { ok: true, output: { closed: false, already_closed: true } })
    guard.record('browser_status', {}, { ok: true, output: { session: null } })
    expect(guard.canOffer('browser_open')).toBe(false)
    guard.record('browser_close', {}, { ok: true, output: { closed: true } })
    expect(guard.canOffer('browser_open')).toBe(true)
    expect(guard.blocked('browser_navigate', {})).toBeUndefined()
  })

  it('also bounds failing cleanup while leaving status and unrelated tools available', () => {
    const guard = new ToolRecoveryGuard()
    for (let index = 0; index < 3; index++)
      guard.record('browser_close', {}, { ok: false, error: 'workflow_browser_cleanup_failed' })
    expect(guard.blocked('browser_close', {})).toMatchObject({ ok: false, output: { code: 'tool_recovery_required' } })
    expect(guard.canOffer('browser_status')).toBe(true)
    expect(guard.blocked('fs_read', { path: '@project/report.md' })).toBeUndefined()
    expect(new ToolRecoveryGuard().canOffer('browser_close')).toBe(true)
  })

  it('keeps OCR and explicit external vision available when only local vision is unavailable', () => {
    const guard = new ToolRecoveryGuard()
    guard.record(
      'image_analyze',
      { action: 'vision' },
      { ok: false, output: { code: 'workflow_vision_multimodal_runtime_unavailable' } }
    )
    expect(guard.blocked('image_analyze', { action: 'vision', instruction: 'Anderer Prompt' })).toMatchObject({
      ok: false,
    })
    expect(guard.blocked('image_analyze', { action: 'ocr' })).toBeUndefined()
    expect(guard.blocked('image_analyze', { action: 'capabilities' })).toBeUndefined()
    expect(guard.blocked('image_analyze', { action: 'vision', inference: 'external' })).toBeUndefined()
  })

  it('asks for a fresh foreground observation without replaying a consumed input action', () => {
    const guard = new ToolRecoveryGuard()
    const outcome = guard.record(
      'os_click',
      { observation_id: 'expired', x: 5, y: 10 },
      { ok: false, error: 'Desktop observation expired; observe the target again.' }
    )
    expect(outcome.output).toMatchObject({
      recovery: { code: 'desktop_observation_required', next_tool: 'os_observe_desktop', next_arguments: {} },
    })
    expect(outcome.ok).toBe(false)
  })
})
