import { describe, expect, it } from 'vitest'
import { buildCoordinationDiagnostic } from '@/services/coordination/diagnostics'

describe('device cluster diagnostics', () => {
  it('retains authority, revision and resource evidence without exporting private content', () => {
    const secret = 'secret-do-not-export'
    const diagnostic = buildCoordinationDiagnostic(
      {
        native: true,
        clientId: 'device-a',
        model: {
          activeModelId: 'small',
          state: 'ready',
          endpoint: secret,
          resourcePlan: { contextTokens: 8192 },
          acceleration: { mode: 'hybrid', offloadedLayers: 12, totalLayers: 32 },
        },
        cluster: {
          connected: true,
          error: secret,
          coordinator: { epoch: 4, leader_device_id: 'device-a', devices: [{ client_id: 'device-b', name: secret }] },
          jobs: [
            {
              id: 'job-1',
              status: 'running',
              master_epoch: 3,
              authority_epoch: 4,
              payload: { prompt: secret },
              result: { answer: secret },
              signature: secret,
            },
          ],
        },
        lan: { active: true, peers: ['device-b'], received: [{ payload: secret }], cert: secret },
        mirrors: { project1: { revision: 8, backupPath: secret, error: secret } },
        journals: [
          {
            state: 'started',
            runId: 'run-1',
            payloadHash: secret,
            result: secret,
            checkpoint: { summary: secret, lastEventSequence: 9 },
          },
        ],
      },
      new Date('2026-09-12T12:00:00Z')
    )
    expect(JSON.stringify(diagnostic)).not.toContain(secret)
    expect(diagnostic.coordination.jobs[0]).toMatchObject({ master_epoch: 3, authority_epoch: 4 })
    expect(diagnostic.model.resources.plan.contextTokens).toBe(8192)
    expect(diagnostic.model.acceleration.mode).toBe('hybrid')
    expect(diagnostic.journals[0]?.checkpoint.lastEventSequence).toBe(9)
    expect(diagnostic.lan).toMatchObject({ peerCount: 1, storedResultCount: 1 })
  })
  it('produces an honest preview with bounded rows and tolerates absent native probes', () => {
    const diagnostic = buildCoordinationDiagnostic({
      native: false,
      journals: Array.from({ length: 300 }, (_, index) => ({ runId: `run-${index}` })),
    })
    expect(diagnostic.native).toBe(false)
    expect(diagnostic.model.acceleration).toEqual({})
    expect(diagnostic.journals).toHaveLength(200)
  })
})
