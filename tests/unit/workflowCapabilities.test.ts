import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ invoke: vi.fn(), account: vi.fn(), request: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mock.account }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
import { refreshWorkflowCapabilities, currentWorkflowEnvironmentHash } from '@/services/workflows/capabilities'
const config = { baseUrl: 'https://server.test', clientId: 'device', deviceKey: 'private-key' }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_WORKFLOW_CODE_HASH', 'a'.repeat(64))
  mock.account.mockResolvedValue({ principalId: 'user:1', config })
  mock.request.mockResolvedValue({ data: {} })
  mock.invoke.mockImplementation(async (command: string) => {
    if (command === 'wf_runtime_capabilities')
      return {
        runtimes: [
          { runtime: 'node', available: true, path: 'C:/private/node.exe' },
          { runtime: 'python', available: false },
        ],
        browser: { available: true },
        image: { capture: true, ocr: false, compare: true },
        build: { appVersion: '2.9.3', platform: 'windows', arch: 'x86_64', contractFingerprint: 'b'.repeat(64) },
        runtimeFingerprint: 'c'.repeat(64),
      }
    if (command === 'local_model_status')
      return {
        state: 'ready',
        manifestAvailable: true,
        activeModelId: 'local-model',
        catalogVersion: 1,
        policyVersion: 1,
      }
    if (command === 'agent_cli_detect') return [{ name: 'codex', available: true }]
    if (command === 'claude_runtime_status') return { available: false }
    throw new Error('Unexpected preparation command')
  })
})
afterEach(() => vi.unstubAllEnvs())
it('reports actual adapters, withholds OCR/vision and never prepares a model or uploads paths', async () => {
  await refreshWorkflowCapabilities(config)
  const report = mock.request.mock.calls[0]![1].body.capabilities
  expect(report.tasks).toContainEqual({ type: 'node.run', version: 1, adapter: 'windows.user.node', available: true })
  expect(report.tasks).toContainEqual(expect.objectContaining({ type: 'python.run', available: false }))
  expect(report.tasks).toContainEqual(expect.objectContaining({ type: 'image.ocr', available: false }))
  expect(report.tasks).toContainEqual(expect.objectContaining({ type: 'image.vision', available: false }))
  expect(report.environment_hash).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(report)).not.toContain('C:/private')
  expect(JSON.stringify(report)).not.toContain('private-key')
  expect(mock.invoke.mock.calls.flat()).not.toContain('local_model_prepare')
})
it('cannot certify code identity for a changing development frontend', async () => {
  vi.stubEnv('VITE_WORKFLOW_CODE_HASH', '')
  expect(await currentWorkflowEnvironmentHash()).toBeNull()
  await refreshWorkflowCapabilities(config)
  expect(
    mock.request.mock.calls[0]![1].body.capabilities.tasks.every((task: { available: boolean }) => !task.available)
  ).toBe(true)
})
it('drops a report after account identity changes during the probe', async () => {
  mock.account
    .mockResolvedValueOnce({ principalId: 'user:1', config })
    .mockResolvedValueOnce({ principalId: 'user:2', config })
  await expect(refreshWorkflowCapabilities(config)).rejects.toThrow('identity_changed')
  expect(mock.request).not.toHaveBeenCalled()
})
