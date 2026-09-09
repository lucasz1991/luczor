import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ invoke: vi.fn(), account: vi.fn(), request: vi.fn(), vision: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mock.invoke }))
vi.mock('@/services/accountPrincipal', () => ({ getVerifiedAccountSnapshot: mock.account }))
vi.mock('@/services/api/luczorApi', () => ({ requestWithConfig: mock.request }))
vi.mock('@/services/workflows/vision', () => ({ getWorkflowVisionCapabilities: mock.vision }))
import { refreshWorkflowCapabilities, currentWorkflowEnvironmentHash } from '@/services/workflows/capabilities'
const config = { baseUrl: 'https://server.test', clientId: 'device', deviceKey: 'private-key' }
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_WORKFLOW_CODE_HASH', 'a'.repeat(64))
  mock.account.mockResolvedValue({ principalId: 'user:1', config })
  mock.request.mockResolvedValue({ data: {} })
  mock.vision.mockResolvedValue({ ready: true, reason_code: null, revision: 'd'.repeat(64) })
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
    if (command === 'codex_runtime_status') return { available: true, transport: 'codex-exec-jsonl' }
    if (command === 'codex_model_capabilities')
      return { revision: 'catalog-v1', source: 'codex-cache', validForSeconds: 300, models: [] }
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

it('reports managed single-agent support without falsely promising a local team or authentication', async () => {
  const original = mock.invoke.getMockImplementation()!
  mock.invoke.mockImplementation(async command =>
    command === 'local_model_status' ? { state: 'stopped', manifestAvailable: true } : original(command)
  )
  await refreshWorkflowCapabilities(config)
  const tasks = mock.request.mock.calls[0]![1].body.capabilities.tasks
  expect(tasks).toContainEqual(
    expect.objectContaining({ type: 'agent.single', available: true, reason: 'managed_runtime_present_auth_unknown' })
  )
  expect(tasks).toContainEqual(expect.objectContaining({ type: 'agent.team', available: false }))
  expect(mock.invoke.mock.calls.map(call => call[0])).not.toContain('agent_cli_detect')
})

it.each(['catalog', 'codex_binary', 'claude_cli', 'claude_binary'])(
  'binds changed managed %s metadata to the evidence environment',
  async changed => {
    const original = mock.invoke.getMockImplementation()!
    const before = await currentWorkflowEnvironmentHash()
    mock.invoke.mockImplementation(async command => {
      const value = await original(command)
      if (changed === 'catalog' && command === 'codex_model_capabilities') return { ...value, revision: 'different' }
      if (changed === 'codex_binary' && command === 'codex_runtime_status')
        return { ...value, executableSha256: 'e'.repeat(64) }
      if (changed === 'claude_cli' && command === 'claude_runtime_status')
        return { ...value, cliVersion: 'new-version' }
      if (changed === 'claude_binary' && command === 'claude_runtime_status')
        return { ...value, runtimeFingerprint: 'f'.repeat(64) }
      return value
    })
    expect(await currentWorkflowEnvironmentHash()).not.toBe(before)
  }
)

it('keeps the same environment for a still-valid catalog TTL decrement', async () => {
  const original = mock.invoke.getMockImplementation()!
  const before = await currentWorkflowEnvironmentHash()
  mock.invoke.mockImplementation(async command => {
    const value = await original(command)
    return command === 'codex_model_capabilities' ? { ...value, validForSeconds: 299 } : value
  })
  expect(await currentWorkflowEnvironmentHash()).toBe(before)
})

it('requires both the native PNG adapter and a ready vision policy and binds policy changes to evidence', async () => {
  const original = mock.invoke.getMockImplementation()!
  mock.invoke.mockImplementation(async command => {
    const value = await original(command)
    if (command === 'wf_runtime_capabilities') return { ...value, image: { ...value.image, prepareVision: true } }
    return value
  })
  await refreshWorkflowCapabilities(config)
  const first = mock.request.mock.calls.at(-1)![1].body.capabilities
  expect(first.tasks).toContainEqual(expect.objectContaining({ type: 'image.vision', available: true }))
  mock.vision.mockResolvedValue({ ready: false, reason_code: 'vision_policy_missing', revision: 'e'.repeat(64) })
  await refreshWorkflowCapabilities(config)
  const second = mock.request.mock.calls.at(-1)![1].body.capabilities
  expect(second.tasks).toContainEqual(
    expect.objectContaining({ type: 'image.vision', available: false, reason: 'vision_policy_missing' })
  )
  expect(first.environment_hash).not.toBe(second.environment_hash)
  expect(mock.invoke.mock.calls.map(call => call[0])).not.toContain('wf_image_action')
})
