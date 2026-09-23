import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const native = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ head: null, segments: [] })) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }))
import { createNativeRunArchiveStore } from '@/services/runs/runArchive'

describe('run archive IPC scope contract', () => {
  it('projects runtime resume parameters onto the exact native scope schema', async () => {
    const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/run-archive-scope-v1.json'), 'utf8'))
    const input = {
      ...fixture,
      sessionId: 'runtime-session',
      generation: 8,
      review: true,
      workspaceBindingId: 'private-path',
    }
    await createNativeRunArchiveStore().read(input)
    expect(native.invoke).toHaveBeenCalledWith('run_archive_read', { payload: { scope: fixture, segmentIds: [] } })
  })
})
