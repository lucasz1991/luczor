import { describe, expect, it } from 'vitest'
import {
  activityLabel,
  createChatActivity,
  finishChatActivity,
  presentToolCall,
  updateChatActivity,
} from '@/services/chatActivity'
import type { PendingToolCall } from '@/state/types'

describe('chat activity lifecycle', () => {
  it('updates a model round without creating one row per token', () => {
    const activity = createChatActivity(1000)
    updateChatActivity(activity, { phase: 'routing' })
    updateChatActivity(activity, { phase: 'thinking', round: 1 })
    for (let characters = 1; characters <= 100; characters++)
      updateChatActivity(activity, { phase: 'receiving', round: 1, characters })
    expect(activity.steps).toHaveLength(4)
    expect(activity.steps[0]?.status).toBe('done')
    expect(activity.steps[3]).toMatchObject({
      label: 'Antwort wird geschrieben',
      status: 'running',
      detail: '100 Zeichen empfangen · Runde 1',
    })
    updateChatActivity(activity, { phase: 'tools', round: 1 })
    updateChatActivity(activity, { phase: 'thinking', round: 2 })
    expect(activity.steps[2]?.status).toBe('done')
    expect(activity.steps[3]?.status).toBe('done')
    expect(activity.steps[4]?.label).toBe('Werkzeuge ausführen')
    expect(activity.steps[5]?.status).toBe('running')
    finishChatActivity(activity, 'done', 5500)
    expect(activity.finishedAt! - activity.startedAt).toBe(4500)
    expect(activity.steps.every(step => step.status === 'done')).toBe(true)
  })

  it.each(['canceled', 'failed'] as const)('settles %s turns and ignores late stream events', status => {
    const activity = createChatActivity(0)
    updateChatActivity(activity, { phase: 'thinking', round: 1 })
    finishChatActivity(activity, status, 500)
    const snapshot = structuredClone(activity)
    updateChatActivity(activity, { phase: 'receiving', round: 1, characters: 999 })
    finishChatActivity(activity, 'done', 1000)
    expect(activity).toEqual(snapshot)
    expect(activity.steps[1]?.status).toBe(status)
    expect(activityLabel(activity, false)).toContain(status === 'canceled' ? 'abgebrochen' : 'fehlgeschlagen')
  })

  it('shows approvals without exposing tool arguments or private results in telemetry', () => {
    const activity = createChatActivity()
    expect(activityLabel(activity, true)).toBe('Wartet auf deine Freigabe')
    const call: PendingToolCall = {
      id: 'call',
      projectId: 'project',
      name: 'file_read',
      status: 'proposed',
      args: { content: 'private-test-payload' },
      result: { toolCallId: 'call', name: 'file_read', ok: true, output: 'private-test-result', ts: 0 },
      requiresApproval: true,
      createdAt: 0,
      updatedAt: 0,
    }
    expect(presentToolCall(call)).toEqual({ id: 'call', label: 'file_read', status: 'waiting', detail: undefined })
    expect(JSON.stringify(presentToolCall(call))).not.toContain('private-test')
    expect(presentToolCall({ ...call, status: 'failed' }).status).toBe('failed')
    expect(presentToolCall({ ...call, status: 'rejected' }).status).toBe('canceled')
  })
})
