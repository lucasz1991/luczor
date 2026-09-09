import { invoke } from '@tauri-apps/api/core'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import type { NativeLocalModelStatus } from '@/services/inference/tauriLocalRuntime'
import { workflowHash } from './executionLedger'

type NativeProbe = {
  runtimes: Array<{ runtime: string; available: boolean }>
  browser: { available: boolean }
  image: { capture: boolean; compare: boolean; ocr: boolean }
  build: { appVersion: string; platform: string; arch: string; contractFingerprint: string }
  runtimeFingerprint: string
}
type Capability = { type: string; version: 1; adapter: string; available: boolean; reason?: string }
const SHA256 = /^[a-f0-9]{64}$/u
const pending = new Map<string, Promise<unknown>>()
const recent = new Map<string, number>()

async function probe() {
  const [native, local] = await Promise.all([
    invoke<NativeProbe>('wf_runtime_capabilities'),
    invoke<NativeLocalModelStatus>('local_model_status').catch(() => null),
  ])
  const frontend = import.meta.env.VITE_WORKFLOW_CODE_HASH as string | undefined
  if (!native?.build || !SHA256.test(native.runtimeFingerprint) || !SHA256.test(native.build.contractFingerprint))
    throw new Error('workflow_capability_native_contract_missing')
  const released = typeof frontend === 'string' && SHA256.test(frontend)
  const environmentHash = await workflowHash({
    frontend: released ? frontend : 'development-unverified',
    native: native.runtimeFingerprint,
    contract: native.build.contractFingerprint,
    build: native.build,
    model: local?.activeModelId ?? null,
    catalog: local?.catalogVersion ?? null,
    policy: local?.policyVersion ?? null,
    resources: local?.resourceConfig?.appliedRevision ?? null,
  })
  return { native, local, released, environmentHash }
}
export async function currentWorkflowEnvironmentHash(): Promise<string | null> {
  const value = await probe()
  return value.released ? value.environmentHash : null
}

/** Probe installed runtimes without preparing, downloading or starting a model. */
export async function refreshWorkflowCapabilities(
  config: LuczorApiConfigSnapshot,
  signal?: AbortSignal
): Promise<unknown> {
  signal?.throwIfAborted()
  const identity = await getVerifiedAccountSnapshot()
  if (
    !identity ||
    identity.config.baseUrl !== config.baseUrl ||
    identity.config.clientId !== config.clientId ||
    identity.config.deviceKey !== config.deviceKey
  )
    throw new Error('workflow_capability_identity_changed')
  const { native, local, released, environmentHash } = await probe()
  const tasks: Capability[] = []
  const add = (types: string[], adapter: string, available: boolean, reason = 'runtime_not_available') => {
    for (const type of types)
      tasks.push({
        type,
        version: 1,
        adapter,
        available: available && released,
        ...(!released ? { reason: 'verified_release_build_required' } : !available ? { reason } : {}),
      })
  }
  add(
    [
      'browser.open',
      'browser.open_url',
      'browser.navigate',
      'browser.click',
      'browser.fill',
      'browser.select',
      'browser.wait',
      'browser.read',
      'browser.screenshot',
      'browser.download',
    ],
    'browser.session',
    native.browser.available
  )
  for (const name of ['node', 'python'])
    add(
      [`${name}.run`],
      `windows.user.${name}`,
      native.runtimes.some(item => item.runtime === name && item.available)
    )
  const inference = !!local?.manifestAvailable && ['ready', 'busy'].includes(local.state) && !!local.activeModelId
  add(
    ['llm', 'llm.text', 'llm.json', 'llm.classify', 'llm.extract', 'llm.evaluate'],
    'inference',
    inference,
    'local_model_not_ready'
  )
  add(['agent.single', 'agent.team'], 'agent.orchestrator', inference, 'local_orchestrator_not_ready')
  const agents = await invoke<Array<{ name: string; available: boolean }>>('agent_cli_detect').catch(() => [])
  const claude = await invoke<{ available: boolean }>('claude_runtime_status').catch(() => ({ available: false }))
  add(
    ['agent.dispatch'],
    'agent.orchestrator',
    agents.some(agent => agent.name === 'codex' && agent.available) || claude.available
  )
  add(['file.read', 'file.write', 'api.call'], 'desktop.tools', true)
  add(['image.capture'], 'desktop.image', native.image.capture)
  add(['image.ocr'], 'desktop.image', native.image.ocr, 'ocr_language_unavailable')
  add(['image.compare'], 'desktop.image', native.image.compare)
  add(['image.vision'], 'desktop.image', false, 'multimodal_runtime_unavailable')
  signal?.throwIfAborted()
  const current = await getVerifiedAccountSnapshot()
  if (
    !current ||
    current.principalId !== identity.principalId ||
    current.config.baseUrl !== config.baseUrl ||
    current.config.clientId !== config.clientId ||
    current.config.deviceKey !== config.deviceKey
  )
    throw new Error('workflow_capability_identity_changed')
  return requestWithConfig(
    '/workflows/device-capabilities',
    {
      method: 'POST',
      signal,
      body: {
        device_id: config.clientId,
        capabilities: { schema_version: 1, environment_hash: environmentHash, tasks },
      },
    },
    config
  )
}

/** Periodic reporting failures never stop the ordinary job transport. */
export function reportWorkflowCapabilitiesIfDue(
  config: LuczorApiConfigSnapshot,
  signal: AbortSignal
): Promise<unknown> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return Promise.resolve(null)
  const key = `${config.baseUrl}:${config.clientId}`
  const active = pending.get(key)
  if (active) return active
  if (Date.now() - (recent.get(key) ?? 0) < 60_000) return Promise.resolve(null)
  recent.set(key, Date.now())
  const work = refreshWorkflowCapabilities(config, signal)
    .catch(() => null)
    .finally(() => pending.delete(key))
  pending.set(key, work)
  return work
}
