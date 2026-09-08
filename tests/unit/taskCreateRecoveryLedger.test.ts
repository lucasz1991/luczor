import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const values = new Map<string, unknown>()
  const store = {
    get: vi.fn(async (key: string) => values.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value))
    }),
    save: vi.fn(async () => undefined),
  }
  const invoke = vi.fn(async (command: string) => {
    if (command === 'memory_key_get_or_create') return 'ab'.repeat(32)
    throw new Error(`Unexpected command: ${command}`)
  })
  return { values, store, invoke }
})

vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: vi.fn(async () => harness.store) } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: harness.invoke }))

import { loadPendingTaskCreates, replacePendingTaskCreates } from '@/services/agents/taskCreateRecoveryLedger'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

describe('durable task-create recovery ledger', () => {
  beforeEach(() => {
    harness.values.clear()
    vi.clearAllMocks()
  })

  it('persists unresolved operations and excludes completed verification state', async () => {
    await replacePendingTaskCreates('server/account-a', 'project-a', [
      {
        projectId: 'project-a',
        principalScopeId: 'server/account-a',
        title: 'Analyse',
        externalId: firstId,
        fingerprint: 'payload-a-SECRET_DESCRIPTION',
        fingerprintHash: 'a'.repeat(64),
        state: 'unknown',
      },
      {
        projectId: 'project-a',
        principalScopeId: 'server/account-a',
        title: 'Bereits da',
        externalId: secondId,
        fingerprintHash: 'b'.repeat(64),
        state: 'verified_present',
      },
    ])

    await expect(loadPendingTaskCreates('server/account-a', 'project-a')).resolves.toEqual([
      expect.objectContaining({ externalId: firstId, state: 'unknown', fingerprintHash: 'a'.repeat(64) }),
    ])
    await expect(loadPendingTaskCreates('server/account-b', 'project-a')).resolves.toEqual([])
    expect(typeof harness.values.get('entries')).toBe('string')
    expect(String(harness.values.get('entries'))).not.toContain('payload-a')
    expect(String(harness.values.get('entries'))).not.toContain('Analyse')
  })

  it('replaces only the selected principal and project partition', async () => {
    await replacePendingTaskCreates('server/account-a', 'project-a', [
      {
        projectId: 'project-a',
        title: 'A',
        externalId: firstId,
        fingerprintHash: 'a'.repeat(64),
        state: 'verified_absent',
      },
    ])
    await replacePendingTaskCreates('server/account-a', 'project-b', [
      {
        projectId: 'project-b',
        title: 'B',
        externalId: secondId,
        fingerprintHash: 'b'.repeat(64),
        state: 'unknown',
      },
    ])
    await replacePendingTaskCreates('server/account-a', 'project-a', [])

    await expect(loadPendingTaskCreates('server/account-a', 'project-a')).resolves.toEqual([])
    await expect(loadPendingTaskCreates('server/account-a', 'project-b')).resolves.toEqual([
      expect.objectContaining({ externalId: secondId, title: 'B' }),
    ])
  })

  it('persists the resource kind for an uncertain conversation without changing legacy task entries', async () => {
    await replacePendingTaskCreates('server/account-a', 'project-a', [
      {
        kind: 'conversation',
        projectId: 'project-a',
        title: 'Projektanalyse',
        externalId: firstId,
        fingerprintHash: 'c'.repeat(64),
        state: 'unknown',
      },
      {
        projectId: 'project-a',
        title: 'Aufgabe',
        externalId: secondId,
        fingerprintHash: 'd'.repeat(64),
        state: 'verified_absent',
      },
    ])

    await expect(loadPendingTaskCreates('server/account-a', 'project-a')).resolves.toEqual([
      expect.objectContaining({ kind: 'conversation', externalId: firstId }),
      expect.not.objectContaining({ kind: 'conversation', externalId: secondId }),
    ])
  })

  it('fails closed for corrupted documents and entries', async () => {
    harness.values.set('entries', { version: 99, entries: [] })
    await expect(loadPendingTaskCreates('server/account-a', 'project-a')).rejects.toThrow('unbekanntes Format')

    harness.values.set('entries', { version: 1, entries: [{ externalId: firstId }] })
    await expect(loadPendingTaskCreates('server/account-a', 'project-a')).rejects.toThrow('ungültigen Eintrag')
  })

  it('strictly migrates the valid pre-version array format on the next write', async () => {
    harness.values.set('entries', [
      {
        principalScopeId: 'server/account-a',
        projectId: 'project-a',
        title: 'Altbestand',
        externalId: firstId,
        fingerprintHash: 'a'.repeat(64),
        state: 'unknown',
        updatedAt: new Date(0).toISOString(),
      },
    ])

    await replacePendingTaskCreates('server/account-a', 'project-b', [])

    expect(typeof harness.values.get('entries')).toBe('string')
    await expect(loadPendingTaskCreates('server/account-a', 'project-a')).resolves.toEqual([
      expect.objectContaining({ externalId: firstId }),
    ])
  })

  it('serializes a legacy migration with a concurrent partition replacement', async () => {
    harness.values.set('entries', [
      {
        principalScopeId: 'server/account-a',
        projectId: 'project-a',
        title: 'Altbestand',
        externalId: firstId,
        fingerprintHash: 'a'.repeat(64),
        state: 'unknown',
        updatedAt: new Date(0).toISOString(),
      },
    ])
    let releaseMigration!: () => void
    const migrationBlocked = new Promise<void>(resolve => {
      releaseMigration = resolve
    })
    let migrationReachedSet!: () => void
    const migrationAtSet = new Promise<void>(resolve => {
      migrationReachedSet = resolve
    })
    harness.store.set.mockImplementationOnce(async (key: string, value: unknown) => {
      migrationReachedSet()
      await migrationBlocked
      harness.values.set(key, structuredClone(value))
    })

    const loading = loadPendingTaskCreates('server/account-a', 'project-a')
    await migrationAtSet
    const replacing = replacePendingTaskCreates('server/account-a', 'project-a', [
      {
        projectId: 'project-a',
        title: 'Neuer Guard',
        externalId: secondId,
        fingerprintHash: 'b'.repeat(64),
        state: 'verified_absent',
      },
    ])
    releaseMigration()

    await loading
    await replacing
    await expect(loadPendingTaskCreates('server/account-a', 'project-a')).resolves.toEqual([
      expect.objectContaining({ externalId: secondId, title: 'Neuer Guard', state: 'verified_absent' }),
    ])
  })

  it('rejects a tampered encrypted ledger instead of treating it as empty', async () => {
    await replacePendingTaskCreates('server/account-a', 'project-a', [
      {
        projectId: 'project-a',
        title: 'Sicher',
        externalId: firstId,
        fingerprintHash: 'a'.repeat(64),
        state: 'unknown',
      },
    ])
    const envelope = JSON.parse(String(harness.values.get('entries'))) as { ciphertext: string }
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -4)}AAAA`
    harness.values.set('entries', JSON.stringify(envelope))

    await expect(loadPendingTaskCreates('server/account-a', 'project-a')).rejects.toThrow('nicht entschlüsselt')
  })

  it('rejects a 501st retained operation without replacing the valid ledger', async () => {
    const full = Array.from({ length: 500 }, (_, index) => ({
      projectId: 'project-a',
      title: `Aufgabe ${index}`,
      externalId: crypto.randomUUID(),
      fingerprintHash: index.toString(16).padStart(64, '0'),
      state: 'unknown' as const,
    }))
    await replacePendingTaskCreates('server/account-a', 'project-a', full)
    const before = harness.values.get('entries')

    await expect(
      replacePendingTaskCreates('server/account-a', 'project-b', [
        {
          projectId: 'project-b',
          title: 'Eine zu viel',
          externalId: secondId,
          fingerprintHash: 'f'.repeat(64),
          state: 'unknown',
        },
      ])
    ).rejects.toThrow('Eintragszahl')
    expect(harness.values.get('entries')).toBe(before)
  })

  it('rejects an oversized encrypted envelope without writing it', async () => {
    const principal = `server/${'a'.repeat(990)}`
    const project = `p${'b'.repeat(199)}`
    const oversized = Array.from({ length: 500 }, (_, index) => ({
      projectId: project,
      title: `${index}-${'Titel'.repeat(47)}`,
      externalId: crypto.randomUUID(),
      fingerprintHash: index.toString(16).padStart(64, '0'),
      state: 'unknown' as const,
    }))

    await expect(replacePendingTaskCreates(principal, project, oversized)).rejects.toThrow('Größenlimit')
    expect(harness.values.has('entries')).toBe(false)
  })
})
