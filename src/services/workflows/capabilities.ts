import { invoke } from '@tauri-apps/api/core'
import { getVerifiedAccountSnapshot } from '@/services/accountPrincipal'
import { requestWithConfig, type LuczorApiConfigSnapshot } from '@/services/api/luczorApi'
import type { NativeLocalModelStatus } from '@/services/inference/tauriLocalRuntime'
import { workflowHash } from './executionLedger'
import { CLAUDE_CAPABILITIES } from '@/services/agents/claudeAgent'
import type { AgentCapabilityCatalog } from '@/services/agents/effort'

type NativeProbe = {
  runtimes: Array<{ runtime: string; available: boolean }>
  browser: { available: boolean }
  image: { capture: boolean; compare: boolean; ocr: boolean; prepareVision?: boolean }
  build: { appVersion: string; platform: string; arch: string; contractFingerprint: string }
  runtimeFingerprint: string
}
type Capability = { type: string; version: 1; adapter: string; available: boolean; reason?: string }
type ManagedRuntimeProbe = {
  available: boolean
  transport?: string
  sdkVersion?: string
  cliVersion?: string
  executableSha256?: string
  runtimeFingerprint?: string
}
const SHA256 = /^[a-f0-9]{64}$/u
const pending = new Map<string, Promise<unknown>>()
const recent = new Map<string, number>()

async function probe(config?: LuczorApiConfigSnapshot, signal?: AbortSignal) {
  const [native, local, codex, claude, codexCatalog] = await Promise.all([
    invoke<NativeProbe>('wf_runtime_capabilities'),
    invoke<NativeLocalModelStatus>('local_model_status').catch(() => null),
    invoke<ManagedRuntimeProbe>('codex_runtime_status').catch(() => ({ available: false }) as ManagedRuntimeProbe),
    invoke<ManagedRuntimeProbe>('claude_runtime_status').catch(() => ({ available: false }) as ManagedRuntimeProbe),
    invoke<AgentCapabilityCatalog>('codex_model_capabilities').catch(() => null),
  ])
  const frontend = import.meta.env.VITE_WORKFLOW_CODE_HASH as string | undefined
  if (!native?.build || !SHA256.test(native.runtimeFingerprint) || !SHA256.test(native.build.contractFingerprint))
    throw new Error('workflow_capability_native_contract_missing')
  const released = typeof frontend === 'string' && SHA256.test(frontend)
  const vision =
    native.image.prepareVision && config
      ? await import('./vision').then(module => module.getWorkflowVisionCapabilities(config, signal)).catch(() => null)
      : null
  const environmentHash = await workflowHash({
    frontend: released ? frontend : 'development-unverified',
    native: native.runtimeFingerprint,
    contract: native.build.contractFingerprint,
    build: native.build,
    model: local?.activeModelId ?? null,
    catalog: local?.catalogVersion ?? null,
    policy: local?.policyVersion ?? null,
    resources: local?.resourceConfig?.appliedRevision ?? null,
    vision: vision?.revision ?? null,
    agents: {
      codex: {
        available: codex.available,
        transport: codex.transport ?? null,
        binary: codex.executableSha256 && SHA256.test(codex.executableSha256) ? codex.executableSha256 : 'unconfirmed',
        catalog: codexCatalog?.revision ?? null,
        source: codexCatalog?.source ?? null,
        // Cache TTL changes every second and is not a different execution environment.
        catalogUsable: !!codexCatalog?.validForSeconds && codexCatalog.validForSeconds > 0,
      },
      claude: {
        available: claude.available,
        sdk: claude.sdkVersion ?? null,
        cli: claude.cliVersion ?? null,
        binary:
          claude.runtimeFingerprint && SHA256.test(claude.runtimeFingerprint)
            ? claude.runtimeFingerprint
            : 'unconfirmed',
        catalog: CLAUDE_CAPABILITIES.revision,
      },
    },
  })
  return { native, local, released, environmentHash, vision, codex, claude }
}
export async function currentWorkflowEnvironmentHash(): Promise<string | null> {
  const identity = await getVerifiedAccountSnapshot()
  const value = await probe(identity?.config)
  const current = await getVerifiedAccountSnapshot()
  return value.released &&
    identity &&
    current?.principalId === identity.principalId &&
    current.config.baseUrl === identity.config.baseUrl &&
    current.config.clientId === identity.config.clientId &&
    current.config.deviceKey === identity.config.deviceKey
    ? value.environmentHash
    : null
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
  const { native, local, released, environmentHash, vision, codex, claude } = await probe(config, signal)
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
  const managed = codex.available || claude.available
  add(['agent.single'], 'agent.orchestrator', inference || managed, 'agent_runtime_not_available')
  add(['agent.team'], 'agent.orchestrator', inference, 'local_orchestrator_not_ready')
  add(['agent.dispatch'], 'agent.orchestrator', managed)
  // A usable adapter contract is not proof of authentication, model access or approved egress.
  for (const task of tasks) {
    if (task.available && managed && (task.type === 'agent.dispatch' || (!inference && task.type === 'agent.single')))
      task.reason = 'managed_runtime_present_auth_unknown'
  }
  add(['file.read', 'file.write', 'api.call'], 'desktop.tools', true)
  add(['image.capture'], 'desktop.image', native.image.capture)
  add(['image.ocr'], 'desktop.image', native.image.ocr, 'ocr_language_unavailable')
  add(['image.compare'], 'desktop.image', native.image.compare)
  add(
    ['image.vision'],
    'desktop.image',
    native.image.prepareVision === true && vision?.ready === true,
    vision?.reason_code ?? 'multimodal_runtime_unavailable'
  )
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
