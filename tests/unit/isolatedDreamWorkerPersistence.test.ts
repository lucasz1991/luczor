import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { idleOptimizationDependencies } from '@/services/agents/idleOptimization'

// Only the native storage boundary is replaced. The worker, planner, validation,
// encryption, CAS checks, memory application and receipt journal are production code.
const isolated = vi.hoisted(() => ({ root: '', seed: '22'.repeat(32), principalId: 'synthetic-dream-worker' }))
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: async (name: string) => {
      if (!/^[a-zA-Z0-9._-]+\.json$/.test(name) || !isolated.root) throw new Error('unowned_test_store')
      const fs = await import('node:fs/promises')
      const paths = await import('node:path')
      const filename = paths.join(isolated.root, name)
      let values: Record<string, unknown> = {}
      try {
        values = JSON.parse(await fs.readFile(filename, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return {
        get: async (key: string) => Reflect.get(values, key),
        set: async (key: string, value: unknown) => {
          Object.defineProperty(values, key, { value, enumerable: true, configurable: true, writable: true })
        },
        delete: async (key: string) => Reflect.deleteProperty(values, key),
        save: async () => {
          await fs.writeFile(`${filename}.tmp`, JSON.stringify(values), 'utf8')
          await fs.rename(`${filename}.tmp`, filename)
        },
      }
    },
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'memory_key_get_or_create') return isolated.seed
    throw new Error('unexpected_native_command')
  },
}))
vi.mock('@/services/accountPrincipal', () => ({
  getVerifiedAccountSnapshot: async () => ({
    principalId: isolated.principalId,
    serverInstance: 'synthetic',
    serverOrigin: 'https://synthetic.invalid',
    accountId: 1,
    config: { baseUrl: 'https://synthetic.invalid', deviceKey: 'synthetic-test-key', clientId: 'synthetic-device' },
  }),
}))
vi.mock('@/services/executionGate', () => ({
  executionGate: { capture: () => ({ sessionId: 'synthetic', generation: 1 }), assert: () => undefined },
}))
vi.mock('@/services/memory/maintenanceAdapters', () => ({
  memoryMaintenanceAdapters: [],
  writableMaintenanceAdapter: () => false,
}))
vi.mock('@/services/repositoryGraph', () => ({ inspectRepositoryGraph: async () => ({ files: [], total: 0 }) }))

beforeEach(async () => {
  vi.resetModules()
  isolated.root = await mkdtemp(path.join(tmpdir(), 'luczor-worker-regression-'))
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network_forbidden_in_synthetic_worker_test')
    })
  )
  const { Store } = await import('@tauri-apps/plugin-store')
  const settings = await Store.load('luczor.settings.json')
  await settings.set('memory_use_server', false)
  await settings.save()
  vi.useFakeTimers()
})
afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  // This path is created by mkdtemp above; no production path may be removed.
  if (
    isolated.root &&
    path.dirname(isolated.root) === path.resolve(tmpdir()) &&
    path.basename(isolated.root).startsWith('luczor-worker-regression-')
  )
    await rm(isolated.root, { recursive: true, force: true })
  isolated.root = ''
})

async function setup(alwaysMalformed = false) {
  const { luczorMemory, LuczorMemoryService } = await import('@/services/memory/luczorMemory')
  const { MAINTENANCE_POLICY } = await import('@/services/memory/maintenance')
  const { createMaintenanceWorker } = await import('@/services/agents/idleMaintenanceWorker')
  const { dreamTrace } = await import('@/services/memory/dreamTrace')
  const original = await luczorMemory.remember({
    scope: 'user',
    visibility: 'private',
    writeIntent: 'confirmed',
    source: 'user',
    content: 'Synthetic Elbe uses docs/start.md. Changes require review.',
  })
  await luczorMemory.updateMaintenance(isolated.principalId, journal => {
    journal.consent = { automaticRewrite: true, installedModelStart: false, metadataAnnotations: false }
    // Test gate only. This never creates authorization in the installed application.
    journal.quality = {
      policy: MAINTENANCE_POLICY,
      modelId: 'synthetic',
      catalogHash: 'synthetic',
      passed: true,
      at: Date.now(),
      reason: 'synthetic_test',
    }
  })
  let proposals = 0
  const stream = vi.fn(async (request: { messages: Array<{ content: string }> }) => {
    const review = request.messages[1]!.content.startsWith('Unabhängige Prüfung')
    const content = review
      ? JSON.stringify({
          approved: true,
          checkedSources: [original.id],
          unsupportedFacts: false,
          lostFacts: false,
          lostConstraints: false,
          temporalConflict: false,
        })
      : JSON.stringify({
          operations: [
            {
              operation: 'rewrite',
              targets: ++proposals === 1 || alwaysMalformed ? [] : [original.id],
              sources: [original.id],
              content: 'Synthetic Elbe: docs/start.md. Changes require review.',
              reason: 'Same synthetic facts, clearer wording.',
            },
          ],
        })
    return { content, toolCalls: [], rawToolCalls: [], finishReason: 'stop' }
  })
  const deps = {
    native: () => true,
    account: async () => ({ principalId: isolated.principalId, serverInstance: 'synthetic' }),
    policy: () => ({ mode: 'active', manifest: { payloadSha256: 'synthetic' }, appliedResourceRevision: 1 }),
    preferences: async () => ({ autoRemember: true }),
    status: async () => ({ operational: true, state: 'ready', modelId: 'synthetic' }),
    metrics: async () => ({ ram_total_mb: 16000, ram_used_mb: 4000, cpu_percent: 5 }),
    resources: { hasWork: () => false, runBackground: async (operation: () => Promise<string>) => operation() },
    gateway: async () => ({ target: 'local_llama_cpp', streamChatWithTools: stream }),
    prepare: async () => 'synthetic',
    graphStatus: async () => ({ status: 'unbound' }),
    improve: async () => 'not_scheduled',
  } as unknown as typeof idleOptimizationDependencies
  const worker = createMaintenanceWorker(
    { project: () => undefined, projects: () => [], busy: () => false },
    deps,
    () => true
  )
  return { worker, stream, original, luczorMemory, LuczorMemoryService, dreamTrace }
}

async function run(worker: Awaited<ReturnType<typeof setup>>['worker']) {
  worker.start()
  worker.requestNow()
  await vi.advanceTimersByTimeAsync(2)
  await vi.waitFor(() => expect(['cooldown', 'paused']).toContain(worker.snapshot().phase), { timeout: 4000 })
}

describe('isolated worker with actual encrypted memory persistence', () => {
  it('corrects once, verifies and persists one atomic rewrite across service reload', async () => {
    const test = await setup()
    try {
      await run(test.worker)
      expect(test.stream).toHaveBeenCalledTimes(3)
      await vi.waitFor(() => expect(test.dreamTrace.value.current).toBeNull())
      expect(test.dreamTrace.value.history[0]?.outcome).toBe('success')
      const restarted = new test.LuczorMemoryService()
      const snapshot = await restarted.maintenanceSnapshot(isolated.principalId)
      expect(snapshot.journal.receipts).toHaveLength(1)
      expect(snapshot.journal.receipts[0]?.changed).toBe(1)
      expect(snapshot.journal.jobs.find(job => job.kind === 'memory')?.status).toBe('completed')
      expect(snapshot.records.map(record => record.content)).toEqual([
        'Synthetic Elbe: docs/start.md. Changes require review.',
      ])
      expect(snapshot.records.some(record => record.id === test.original.id)).toBe(false)
      expect(test.dreamTrace.value.history[0]?.decisions.every(decision => decision.effectState === 'committed')).toBe(
        true
      )
      // Only the mkdtemp-owned synthetic store created above is inspected.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const persisted = await readFile(path.join(isolated.root, 'luczor.memory.json'), 'utf8')
      expect(persisted).toContain('state_v3_encrypted')
      expect(persisted).not.toContain('Synthetic Elbe')
      expect((await restarted.maintenanceSnapshot(isolated.principalId)).journal.receipts).toHaveLength(1)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await test.worker.stop()
    }
  })

  it('preserves original memory and gate across reload after two invalid proposals', async () => {
    const test = await setup(true)
    try {
      await run(test.worker)
      expect(test.stream).toHaveBeenCalledTimes(2)
      await vi.waitFor(async () =>
        expect(
          (await test.luczorMemory.maintenanceSnapshot(isolated.principalId)).journal.jobs.find(
            job => job.kind === 'memory'
          )?.status
        ).toBe('retry')
      )
      const snapshot = await new test.LuczorMemoryService().maintenanceSnapshot(isolated.principalId)
      expect(snapshot.journal.receipts).toEqual([])
      expect(snapshot.journal.quality?.passed).toBe(true)
      expect(snapshot.journal.jobs.find(job => job.kind === 'memory')).toMatchObject({ status: 'retry', attempts: 1 })
      expect(snapshot.records.map(record => record.id)).toEqual([test.original.id])
      expect(test.dreamTrace.value.history[0]?.outcome).toBe('failed')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await test.worker.stop()
    }
  })
})
