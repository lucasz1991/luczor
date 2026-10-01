// Opt-in acceptance only. No production endpoints, credentials, stores or process attachment.
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { freemem, totalmem, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const delay = ms => new Promise(done => setTimeout(done, ms))
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i
const coded = code => Object.assign(new Error(code), { code })

export function childEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(systemroot|windir|comspec|path|pathext|temp|tmp|programfiles(?:\(x86\))?)$/i.test(key)
    )
  )
}

export async function residentLlamaProcesses() {
  if (process.platform !== 'win32') throw coded('windows_acceptance_only')
  const result = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "@((Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue) | ForEach-Object { $_.Id }) | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, timeout: 10_000, env: childEnvironment() }
  )
  if (!result.stdout.trim()) return []
  return [JSON.parse(result.stdout)].flat().filter(Number.isSafeInteger)
}

export async function verifyPinnedAsset(assetRoot, entry) {
  if (!entry || typeof entry.relativePath !== 'string' || !/^[a-f\d]{64}$/i.test(entry.sha256 ?? '')) {
    throw coded('invalid_asset_pin')
  }
  const root = await realpath(assetRoot)
  const file = await realpath(resolve(root, entry.relativePath.replace(/[\\/]/g, sep)))
  const child = relative(root, file)
  if (!child || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) throw coded('asset_outside_root')
  const metadata = await stat(file)
  if (!metadata.isFile() || (entry.sizeBytes != null && metadata.size !== entry.sizeBytes))
    throw coded('asset_size_mismatch')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  if (hash.digest('hex') !== entry.sha256.toLowerCase()) throw coded('asset_hash_mismatch')
  return file
}

export async function verifyPinnedRuntimeDistribution(assetRoot, profile) {
  if (!Array.isArray(profile?.assets?.archives) || !profile.assets.archives.length)
    throw coded('runtime_archives_missing')
  const runtime = await verifyPinnedAsset(assetRoot, profile.assets.runtime)
  const archives = []
  for (const pin of profile.assets.archives) archives.push(await verifyPinnedAsset(assetRoot, pin))
  try {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(appRoot, 'scripts/verify-isolated-runtime.ps1'),
        '-RuntimeRoot',
        dirname(runtime),
        '-ArchivesBase64',
        Buffer.from(JSON.stringify(archives)).toString('base64'),
      ],
      { windowsHide: true, env: childEnvironment(), timeout: 120_000, maxBuffer: 4096 }
    )
    const receipt = JSON.parse(stdout.trim())
    if (receipt.status !== 'PASS' || receipt.verifiedArchives !== archives.length || !receipt.verifiedFiles)
      throw coded('runtime_distribution_mismatch')
    return { runtime, ...receipt }
  } catch {
    throw coded('runtime_distribution_mismatch')
  }
}

export function parsePublicStreamEvent(data) {
  if (data === '[DONE]') return { done: true }
  let packet
  try {
    packet = JSON.parse(data)
  } catch {
    throw coded('runtime_stream_invalid_json')
  }
  if (packet.error) throw coded('runtime_stream_failed')
  const choice = packet.choices?.[0]
  if (choice?.delta?.tool_calls?.length) throw coded('unexpected_tool_call')
  // Deliberately never return reasoning_content, analysis or the raw provider packet.
  return {
    content: typeof choice?.delta?.content === 'string' ? choice.delta.content : '',
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage: packet.usage
      ? {
          input: Number.isSafeInteger(packet.usage.prompt_tokens) ? packet.usage.prompt_tokens : undefined,
          output: Number.isSafeInteger(packet.usage.completion_tokens) ? packet.usage.completion_tokens : undefined,
        }
      : undefined,
  }
}

export function createSyntheticGenerator(endpoint, runId, events, fetcher = fetch, apiKey = '', onPublicResponse) {
  const url = new URL(endpoint)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/'
  ) {
    throw coded('non_loopback_endpoint')
  }
  let calls = 0
  return async ({ stage, messages, maxTokens = 768, signal }) => {
    if (++calls > 12) throw coded('synthetic_round_limit')
    if (!Array.isArray(messages) || JSON.stringify(messages).length > 32_000) throw coded('synthetic_context_limit')
    const startedAt = Date.now()
    const callId = `${runId}:model:${calls}`
    events.push({ runId, callId, stage, at: new Date(startedAt).toISOString(), status: 'started' })
    try {
      const response = await fetcher(new URL('v1/chat/completions', url), {
        method: 'POST',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(125_000)]) : AbortSignal.timeout(125_000),
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model: 'luczor-isolated-test',
          messages,
          stream: true,
          max_tokens: Math.min(2048, Math.max(128, maxTokens)),
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
        }),
      })
      if (!response.ok) throw coded(`runtime_http_${response.status}`)
      if (!response.body) throw coded('runtime_stream_missing')
      const decoder = new TextDecoder()
      let buffer = '',
        content = '',
        finishReason = null,
        done = false,
        received = 0
      let usage
      const line = value => {
        if (!value.startsWith('data:')) return
        const event = parsePublicStreamEvent(value.slice(5).trim())
        if (event.done) {
          done = true
          return
        }
        content += event.content ?? ''
        if (event.finishReason) finishReason = event.finishReason
        if (event.usage) usage = event.usage
        if (content.length > 32_000) throw coded('synthetic_output_limit')
      }
      for await (const chunk of response.body) {
        received += chunk.byteLength
        if (received > 512 * 1024) throw coded('synthetic_stream_limit')
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const entry of lines) line(entry.trimEnd())
      }
      buffer += decoder.decode()
      if (buffer) line(buffer.trimEnd())
      if (!done || !finishReason) throw coded('runtime_stream_failed')
      if (finishReason !== 'stop') throw coded(finishReason === 'length' ? 'output_truncated' : 'incomplete_candidate')
      content = content.replace(/<(?:think|analysis)>[\s\S]*?(?:<\/(?:think|analysis)>|$)/gi, '').trim()
      if (!content) throw coded('incomplete_candidate')
      // Opt-in synthetic evidence only: never retain raw packets or private reasoning.
      await onPublicResponse?.({ runId, callId, stage, messages: structuredClone(messages), content, finishReason })
      events.push({
        runId,
        callId,
        stage,
        status: 'PASS',
        durationMs: Date.now() - startedAt,
        finishReason,
        usage,
        publicCharacters: content.length,
      })
      return { content, finishReason, toolCalls: [] }
    } catch (error) {
      const reason = error?.code ?? (signal?.aborted ? 'interrupted' : 'runtime_stream_failed')
      events.push({ runId, callId, stage, status: 'FAIL', reason, durationMs: Date.now() - startedAt })
      throw coded(reason)
    }
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  const port = server.address().port
  await new Promise((done, fail) => server.close(error => (error ? fail(error) : done())))
  return port
}

async function capacity(profile) {
  if (totalmem() < profile.catalog.minTotalRamBytes || freemem() < profile.catalog.minAvailableRamBytes)
    return 'ram_capacity'
  try {
    const { stdout } = await exec('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
      windowsHide: true,
      timeout: 10_000,
      env: childEnvironment(),
    })
    const free = stdout
      .trim()
      .split(/\r?\n/)
      .map(line => Number(line.trim()) * 1024 * 1024)
    if (!free.some(bytes => Number.isFinite(bytes) && bytes >= profile.catalog.minVramBytes)) return 'vram_capacity'
  } catch {
    return 'gpu_capacity_unconfirmed'
  }
  return null
}

async function loadDreamHarness(privateRoot) {
  const require = createRequire(import.meta.url)
  const { build } = require('esbuild')
  const output = join(privateRoot, 'synthetic-dream-harness.mjs')
  await build({
    stdin: {
      contents: `export * from './tests/isolated/dreamAcceptance.ts'; export * from './tests/isolated/dreamFileStore.ts';`,
      resolveDir: appRoot,
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@': join(appRoot, 'src') },
    logLevel: 'silent',
  })
  return import(pathToFileURL(output).href)
}

export function parseSyntheticBrowserActions(content) {
  let actions
  try {
    actions = JSON.parse(
      content
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    )
  } catch {
    throw coded('invalid_synthetic_browser_plan')
  }
  const expected = [
    { action: 'fill', target: 'name', value: 'Luczor synthetic' },
    { action: 'click', target: 'apply' },
    { action: 'select', target: 'platform', value: 'linux' },
    { action: 'click', target: 'reveal' },
    { action: 'click', target: 'dynamic-action' },
  ]
  if (
    !Array.isArray(actions) ||
    actions.length !== expected.length ||
    actions.some(
      (action, i) =>
        !action ||
        typeof action !== 'object' ||
        Object.keys(action).length !== Object.keys(expected[i]).length ||
        Object.entries(expected[i]).some(([key, value]) => action[key] !== value)
    )
  )
    throw coded('invalid_synthetic_browser_plan')
  return actions
}

export function nativeBrowserModelResult(report, runId, reportPath) {
  const valid =
    report?.version === 1 &&
    report.kind === 'native_browser_acceptance' &&
    report.runId === runId &&
    report.status === 'passed' &&
    report.suppliedActionsFinalResult === 'Luczor synthetic' &&
    [1, 2, 3, 4, 5].every(index =>
      report.events?.some(event => event.stage === `supplied_actions_${index}` && event.status === 'passed')
    )
  return {
    status: valid ? 'PASS' : 'FAIL',
    reportPath,
    reason: valid ? 'model_plan_executed_on_synthetic_page' : 'native_browser_probe_failed',
  }
}

/** No attaching to a pre-existing runtime, even when it appears idle. */
async function performIsolatedModelSmoke(options) {
  const { runId, privateRoot, assetRoot = 'D:\\Luczor\\local-model-test' } = options
  if (!uuid.test(runId ?? '') || !isAbsolute(privateRoot ?? '')) throw coded('invalid_isolated_run')
  const residents = await residentLlamaProcesses()
  if (residents.length) return { status: 'WAITING', reason: 'resident_model_in_use', residentCount: residents.length }
  const profile = JSON.parse(
    await readFile(
      options.profilePath ?? options.pinProfile ?? join(appRoot, 'scripts/local-model-test.profile.json'),
      'utf8'
    )
  )
  if (profile.schemaVersion !== 1 || profile.profileId !== 'orcarouter-qwen3.8-27b-windows-cuda-smoke')
    throw coded('unsupported_asset_profile')
  const shortage = await capacity(profile)
  if (shortage) return { status: 'WAITING', reason: shortage }
  const distribution = await verifyPinnedRuntimeDistribution(assetRoot, profile)
  const runtime = distribution.runtime
  const model = await verifyPinnedAsset(assetRoot, profile.assets.model)
  // Recheck after potentially long hashing; never race a known resident process.
  if ((await residentLlamaProcesses()).length) return { status: 'WAITING', reason: 'resident_model_in_use' }
  await mkdir(privateRoot, { recursive: true })
  const port = await freePort()
  const endpoint = `http://127.0.0.1:${port}/`
  const events = []
  const apiKey = randomBytes(32).toString('hex')
  const args = [
    '--model',
    model,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--alias',
    'luczor-isolated-test',
    '--ctx-size',
    String(profile.catalog.contextTokens),
    '--parallel',
    '1',
    '--n-gpu-layers',
    '999',
    '--jinja',
    '--api-key',
    apiKey,
  ]
  const child = spawn(runtime, args, {
    cwd: dirname(runtime),
    env: childEnvironment(),
    windowsHide: true,
    stdio: 'ignore',
  })
  let spawnError = false,
    exited = false
  child.once('error', () => {
    spawnError = true
  })
  child.once('exit', () => {
    exited = true
  })
  let result, browserActions
  try {
    const deadline = Date.now() + Math.min(300, profile.catalog.maxStartupSeconds) * 1000
    let healthy = false
    while (Date.now() < deadline && !exited && !spawnError) {
      try {
        const health = await fetch(new URL('health', endpoint), {
          redirect: 'error',
          signal: AbortSignal.timeout(2000),
        })
        if (health.ok && (await health.json()).status === 'ok') {
          healthy = true
          break
        }
      } catch {
        /* Only this newly owned endpoint can become ready. */
      }
      await delay(250)
    }
    if (!healthy) throw coded(spawnError || exited ? 'owned_runtime_start_failed' : 'owned_runtime_health_timeout')
    // Health itself is public; authenticated generation additionally binds us to our fresh runtime key.
    const publicResponses = []
    const publicEvidencePath = join(privateRoot, 'synthetic-model-public.json')
    const generate = createSyntheticGenerator(endpoint, runId, events, fetch, apiKey, async response => {
      publicResponses.push(response)
      await writeFile(publicEvidencePath, JSON.stringify(publicResponses, null, 2), { mode: 0o600 })
    })
    const harness = await loadDreamHarness(privateRoot)
    const store = await harness.createDreamFileStore(join(privateRoot, 'synthetic-memories.json'), runId)
    const dream = await harness.runDreamAcceptance({ generate, store, runId })
    result = {
      status: dream.status,
      dream,
      pathway: 'isolated_optimizer_direct_llama',
      modelId: profile.assets.model.id,
      runtimeVersion: profile.assets.runtime.version,
      verifiedRuntimeFiles: distribution.verifiedFiles,
      publicEvidencePath,
      modelSha256: profile.assets.model.sha256,
      events,
    }
    try {
      const plan = await generate({
        stage: 'browser-plan',
        maxTokens: 768,
        messages: [
          {
            role: 'user',
            content:
              'This is a synthetic offline browser acceptance test. Return only a JSON array of five actions, in order: fill target name with value Luczor synthetic; click target apply; select target platform with value linux; click target reveal; click target dynamic-action. Each action uses only action, target, and value when fill/select. No tools, scripts, URLs or other fields.',
          },
        ],
      })
      browserActions = parseSyntheticBrowserActions(plan.content)
      result.browserModel = {
        status: 'NOT_RUN',
        reason: 'validated_plan_pending_native_actions',
        actions: browserActions.length,
      }
    } catch (error) {
      result.browserModel = { status: 'FAIL', reason: error?.code ?? 'browser_plan_failed' }
      result.status = 'FAIL'
    }
  } catch (error) {
    result = { status: 'FAIL', reason: error?.code ?? 'isolated_model_test_failed', runId, events }
  } finally {
    // The ChildProcess handle belongs to this launch; never use global process-name cleanup.
    if (!exited && !spawnError) child.kill()
    const cleanupDeadline = Date.now() + 5000
    while (!exited && !spawnError && Date.now() < cleanupDeadline) await delay(50)
    if (!exited && !spawnError) result = { ...result, status: 'FAIL', reason: 'owned_runtime_cleanup_unconfirmed' }
  }
  if (browserActions && result.reason !== 'owned_runtime_cleanup_unconfirmed') {
    const actionsPath = join(privateRoot, 'synthetic-browser-actions.json')
    await writeFile(actionsPath, JSON.stringify(browserActions), { mode: 0o600 })
    const evidenceRoot = resolve(appRoot, '../.lmzdev/artifacts/reports/isolated-functional', runId)
    await mkdir(evidenceRoot, { recursive: true })
    const reportPath = join(evidenceRoot, 'model-browser.json')
    try {
      await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          join(appRoot, 'scripts/test-browser-panel-native.ps1'),
          '-Isolated',
          '-Visible',
          '-RunId',
          runId,
          '-ActionsPath',
          actionsPath,
          '-ReportPath',
          reportPath,
        ],
        { cwd: appRoot, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 1024 * 1024, env: childEnvironment() }
      )
      const report = JSON.parse(await readFile(reportPath, 'utf8'))
      result.browserModel = nativeBrowserModelResult(report, runId, reportPath)
    } catch {
      result.browserModel = { status: 'FAIL', reason: 'native_browser_probe_failed', reportPath }
    }
    if (result.browserModel.status !== 'PASS') result.status = 'FAIL'
  }
  await writeFile(join(privateRoot, 'model-result.json'), `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return result
}

export async function runIsolatedModelSmoke(options) {
  const lockPath = join(tmpdir(), 'luczor-isolated-model-test.lock')
  let lock
  try {
    try {
      lock = await open(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error?.code === 'EEXIST') return { status: 'WAITING', reason: 'another_isolated_test_owns_model' }
      throw error
    }
    return await performIsolatedModelSmoke(options)
  } catch (error) {
    return {
      status: 'FAIL',
      reason: /^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'isolated_model_preflight_failed',
    }
  } finally {
    if (lock) {
      await lock.close()
      await unlink(lockPath)
    }
  }
}
