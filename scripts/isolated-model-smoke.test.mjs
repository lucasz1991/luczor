import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  childEnvironment,
  createSyntheticGenerator,
  parsePublicStreamEvent,
  parseSyntheticBrowserActions,
  verifyPinnedAsset,
  verifyPinnedRuntimeDistribution,
  nativeBrowserModelResult,
} from './isolated-model-smoke.mjs'

test('asset verification rejects changed data and parent traversal; valid content remains untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'luczor-pin-test-'))
  try {
    const file = join(root, 'model.fixture')
    const data = 'synthetic fixture only'
    await writeFile(file, data)
    const pin = {
      relativePath: 'model.fixture',
      sha256: createHash('sha256').update(data).digest('hex'),
      sizeBytes: data.length,
    }
    assert.equal(await verifyPinnedAsset(root, pin), await realpath(file))
    assert.equal(await readFile(file, 'utf8'), data)
    await assert.rejects(verifyPinnedAsset(root, { ...pin, sha256: '0'.repeat(64) }), { code: 'asset_hash_mismatch' })
    await assert.rejects(verifyPinnedAsset(root, { ...pin, relativePath: '../missing.file' }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('child environment excludes credentials and production configuration', () => {
  const env = childEnvironment()
  assert.ok(
    Object.keys(env).every(key =>
      /^(systemroot|windir|comspec|path|pathext|temp|tmp|programfiles(?:\(x86\))?)$/i.test(key)
    )
  )
  for (const name of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const key = Object.keys(process.env).find(key => key.toLowerCase() === name.toLowerCase())
    if (key) assert.equal(env[key], process.env[key])
  }
})

test(
  'runtime verification checks companion DLLs and rejects unexpected executables without editing files',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'luczor-runtime-pin-test-'))
    const runtime = join(root, 'runtime')
    try {
      await mkdir(runtime)
      await writeFile(join(runtime, 'llama-server.exe'), 'synthetic executable only')
      await writeFile(join(runtime, 'ggml.dll'), 'synthetic dll only')
      const zip = join(root, 'runtime.zip')
      const quote = value => `'${value.replaceAll("'", "''")}'`
      await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(runtime)},${quote(zip)})`,
        ],
        { windowsHide: true, env: childEnvironment() }
      )
      const pin = async relativePath => {
        const bytes = await readFile(join(root, relativePath))
        return { relativePath, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
      }
      const archivePin = await pin('runtime.zip')
      const profile = { assets: { runtime: await pin('runtime/llama-server.exe'), archives: [archivePin, archivePin] } }
      const result = await verifyPinnedRuntimeDistribution(root, profile)
      assert.equal(result.status, 'PASS')
      assert.equal(result.verifiedFiles, 2)
      assert.equal(result.verifiedArchives, 2)
      await writeFile(join(runtime, 'ggml.dll'), 'changed dll bytes!')
      await assert.rejects(verifyPinnedRuntimeDistribution(root, profile), { code: 'runtime_distribution_mismatch' })
      await writeFile(join(runtime, 'ggml.dll'), 'synthetic dll only')
      await writeFile(join(runtime, 'untrusted.dll'), 'unexpected file')
      await assert.rejects(verifyPinnedRuntimeDistribution(root, profile), { code: 'runtime_distribution_mismatch' })
      assert.equal(await readFile(join(runtime, 'llama-server.exe'), 'utf8'), 'synthetic executable only')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('provider packets expose only public content, finish reason and numeric usage fields', () => {
  const result = parsePublicStreamEvent(
    JSON.stringify({
      choices: [{ delta: { content: 'Visible', reasoning_content: 'private-thought' }, finish_reason: 'stop' }],
    })
  )
  assert.equal(result.content, 'Visible')
  assert.ok(!JSON.stringify(result).includes('private-thought'))
  assert.throws(() => parsePublicStreamEvent('{bad json'), { code: 'runtime_stream_invalid_json' })
  assert.throws(() => parsePublicStreamEvent(JSON.stringify({ choices: [{ delta: { tool_calls: [{}] } }] })), {
    code: 'unexpected_tool_call',
  })
})

const stream = (finish = 'stop', done = true) =>
  new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'private-thought', content: 'Test result' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`,
      done ? 'data: [DONE]\n\n' : '',
    ].join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )

test('generator enforces loopback, public-only complete output and no automatic retries', async () => {
  assert.throws(() => createSyntheticGenerator('https://example.org/', 'run', []), { code: 'non_loopback_endpoint' })
  for (const [finish, done, code] of [
    ['length', true, 'output_truncated'],
    ['stop', false, 'runtime_stream_failed'],
  ]) {
    const events = []
    let calls = 0
    const generate = createSyntheticGenerator('http://127.0.0.1:9999/', 'synthetic', events, async () => {
      calls++
      return stream(finish, done)
    })
    await assert.rejects(generate({ stage: 'draft', messages: [{ role: 'user', content: 'synthetic' }] }), { code })
    assert.equal(calls, 1)
    assert.equal(events.at(-1).status, 'FAIL')
    assert.ok(!JSON.stringify(events).includes('private-thought'))
  }
  const events = []
  const generate = createSyntheticGenerator('http://127.0.0.1:9999/', 'synthetic', events, async (_url, options) => {
    assert.equal(options.redirect, 'error')
    const body = JSON.parse(options.body)
    assert.equal(body.stream, true)
    assert.ok(!Object.hasOwn(body, 'tools'))
    return stream()
  })
  assert.deepEqual(await generate({ stage: 'draft', messages: [] }), {
    content: 'Test result',
    finishReason: 'stop',
    toolCalls: [],
  })
  assert.equal(events.at(-1).status, 'PASS')
})

test('model browser plan accepts only the exact bounded harmless fixture task', () => {
  const actions = [
    { action: 'fill', target: 'name', value: 'Luczor synthetic' },
    { action: 'click', target: 'apply' },
    { action: 'select', target: 'platform', value: 'linux' },
    { action: 'click', target: 'reveal' },
    { action: 'click', target: 'dynamic-action' },
  ]
  assert.deepEqual(parseSyntheticBrowserActions(JSON.stringify(actions)), actions)
  assert.throws(() =>
    parseSyntheticBrowserActions(JSON.stringify([{ ...actions[0], url: 'https://example.com' }, ...actions.slice(1)]))
  )
  assert.throws(() => parseSyntheticBrowserActions(JSON.stringify(actions.slice(1))))
})

test('synthetic evidence records only complete public responses, never private model reasoning', async () => {
  const evidence = []
  const response = () =>
    new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'private-hidden', content: '<think>private-embedded</think>{"operations":[]}' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join('')
    )
  const generate = createSyntheticGenerator(
    'http://127.0.0.1:9999/',
    'synthetic',
    [],
    async () => response(),
    '',
    entry => evidence.push(entry)
  )
  await generate({ stage: 'proposal', messages: [{ role: 'user', content: 'Synthetic sources only' }] })
  assert.equal(evidence.length, 1)
  assert.equal(evidence[0].content, '{"operations":[]}')
  assert.equal(evidence[0].callId, 'synthetic:model:1')
  assert.ok(!JSON.stringify(evidence).includes('private-'))
})

test('native report uses passed contract and requires all supplied model actions for the same run', () => {
  const report = {
    version: 1,
    kind: 'native_browser_acceptance',
    runId: 'synthetic',
    status: 'passed',
    suppliedActionsFinalResult: 'Luczor synthetic',
    events: [1, 2, 3, 4, 5].map(index => ({ stage: `supplied_actions_${index}`, status: 'passed' })),
  }
  assert.equal(nativeBrowserModelResult(report, 'synthetic', 'report.json').status, 'PASS')
  assert.equal(nativeBrowserModelResult(report, 'other', 'report.json').status, 'FAIL')
  assert.equal(nativeBrowserModelResult({ ...report, status: 'running' }, 'synthetic', 'report.json').status, 'FAIL')
  assert.equal(nativeBrowserModelResult({ ...report, events: [] }, 'synthetic', 'report.json').status, 'FAIL')
  assert.equal(
    nativeBrowserModelResult({ ...report, suppliedActionsFinalResult: '' }, 'synthetic', 'report.json').status,
    'FAIL'
  )
})
