import { describe, expect, it } from 'vitest'
import { buildRecentToolOutcomeContext, toolOutcomePreview } from '@/services/toolOutcomeContext'
import type { Message } from '@/state/types'

function toolMessage(name: string, parsed: unknown, ts: number): Message {
  return {
    id: `m-${ts}`,
    projectId: 'p-1',
    role: 'tool',
    content: '',
    ts,
    createdAt: ts,
    parsed,
    visibility: 'hidden',
    meta: { toolName: name },
  }
}

describe('tool outcome context', () => {
  it('keeps successful output available for audit and the next user turn', () => {
    const message = toolMessage(
      'project_get_state',
      {
        ok: true,
        output: { name: 'Projekt 2', goals: [{ title: 'Test', status: 'open' }] },
      },
      1
    )

    expect(toolOutcomePreview(message)).toContain('Projekt 2')
    const context = buildRecentToolOutcomeContext([message])
    expect(context).toContain('project_get_state: OK')
    expect(context).toContain('Test')
    expect(context).toContain('Behaupte keine darüber hinausgehende Ausführung')
  })

  it('retains failures as evidence instead of reducing them to a status dot', () => {
    const context = buildRecentToolOutcomeContext([
      toolMessage('agent_bridge_write', { ok: false, error: 'project_dir is not a directory' }, 1),
    ])
    expect(context).toContain('agent_bridge_write: FEHLER')
    expect(context).toContain('project_dir is not a directory')
  })
})
