import { describe, expect, it } from 'vitest'
import { ToolRecoveryGuard } from '@/services/tools/toolRecovery'

describe('tool failure recovery', () => {
  it('bounds identical successful discovery loops and keeps the exact previous file target usable', () => {
    const guard = new ToolRecoveryGuard()
    const outcome = { ok: true, output: { entries: [{ path: 'exact.ts', kind: 'file', file_ref: 'file_exact' }] } }
    for (let i = 0; i < 3; i++) {
      guard.record('fs_list', { path: '.', limit: 100 }, outcome)
      guard.record('project_get_state', {}, { ok: true, output: { summary: 'unchanged' } })
    }
    expect(guard.blocked('fs_list', { limit: 100, path: '.' })).toMatchObject({
      ok: false, output: { code: 'tool_read_loop', executed: false,
        next_tool: 'fs_read', next_arguments: { file_ref: 'file_exact' } },
    })
    expect(guard.blocked('fs_list', { path: 'src' })).toBeUndefined()
    expect(guard.blocked('fs_read', { file_ref: 'file_exact' })).toBeUndefined()
    guard.record('fs_read', { file_ref: 'file_exact' }, { ok: true, output: { path: 'exact.ts', content: 'new evidence' } })
    expect(guard.blocked('fs_list', { path: '.', limit: 100 })).toBeUndefined()
  })

  it('allows changed observations, later verification after a write and legitimate asynchronous polling', () => {
    const guard = new ToolRecoveryGuard()
    for (let i = 0; i < 5; i++) {
      guard.record('agent_assist_status', { id: 'job' }, { ok: true, output: { status: 'running' } })
      guard.record('project_get_state', {}, { ok: true, output: { revision: i } })
    }
    expect(guard.blocked('agent_assist_status', { id: 'job' })).toBeUndefined()
    expect(guard.blocked('project_get_state', {})).toBeUndefined()
    for (let i = 0; i < 3; i++) guard.record('project_get_state', {}, { ok: true, output: { revision: 5 } })
    expect(guard.blocked('project_get_state', {})).toBeDefined()
    guard.record('project_set_summary', {}, { ok: true }, true)
    expect(guard.blocked('project_get_state', {})).toBeUndefined()
  })

  it('explains project path failures and browser target failures with different recovery tools', () => {
    const guard = new ToolRecoveryGuard()
    expect(guard.record('fs_read', {}, { ok: false, error: 'path must be relative to the active project' }).output)
      .toMatchObject({ recovery: { code: 'project_relative_path_required', next_tool: 'fs_list' } })
    expect(guard.record('browser_click', {}, { ok: false, error: 'browser_selector_invalid' }).output)
      .toMatchObject({ recovery: { next_tool: 'browser_dom_scan' } })
  })

  it('stops filename guessing while allowing an exactly observed path or file reference', () => {
    const guard = new ToolRecoveryGuard()
    const path = 'luczor_tooltest/ABSCHLUSSBERICHT_2026-09-13.md'
    guard.record(
      'fs_list',
      {},
      {
        ok: true,
        output: {
          entries: [
            { path, kind: 'file', file_ref: 'file_abc' },
            { path: 'reports', kind: 'directory' },
          ],
        },
      }
    )
    for (const wrong of ['ABSCHLUSSBERICHT_5-13.md', 'ABSCHLUSSBERICHRICHT_9-13-13.md']) {
      const outcome = guard.record(
        'fs_read',
        { path: wrong },
        { ok: false, error: 'Project path does not exist or cannot be inspected.' }
      )
      expect(outcome.output).toMatchObject({ recovery: { code: 'file_selection_required', next_tool: 'fs_list' } })
    }
    expect(guard.blocked('fs_read', { path: 'another-guess.md' })).toMatchObject({
      ok: false,
      output: { observed_files: [{ path, file_ref: 'file_abc' }] },
    })
    expect(guard.blocked('fs_read', { path: 'reports' })).toMatchObject({ ok: false })
    expect(guard.blocked('fs_read', { path })).toBeUndefined()
    expect(guard.blocked('fs_read', { file_ref: 'file_abc' })).toBeUndefined()
    expect(guard.blocked('fs_read', { file_ref: 'file_abc', path: 'wrong' })).toMatchObject({ ok: false })
    expect(guard.canOffer('fs_read')).toBe(true)
    guard.record('fs_read', { file_ref: 'file_abc' }, { ok: false, error: 'file_reference_unavailable' })
    expect(guard.blocked('fs_read', { file_ref: 'file_abc' })).toMatchObject({ ok: false })
    guard.record('fs_stat', {}, { ok: true, output: { path, kind: 'file', file_ref: 'file_new' } })
    expect(guard.blocked('fs_read', { file_ref: 'file_new' })).toBeUndefined()
    expect(guard.blocked('fs_list', {})).toBeUndefined()
    expect(new ToolRecoveryGuard().blocked('fs_read', { path: 'unseen.md' })).toBeUndefined()
  })

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
      { observation_id: 'expired' },
      { ok: false, error: 'Desktop observation expired; observe the target again.' }
    )
    expect(outcome.output).toMatchObject({
      recovery: { code: 'desktop_observation_required', next_tool: 'os_observe_desktop', next_arguments: {} },
    })
    expect(outcome.ok).toBe(false)
  })
})
