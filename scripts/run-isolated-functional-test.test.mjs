import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createRun,
  isolatedEnvironment,
  applyResidentState,
  applyModelResult,
  prepareRun,
  runBounded,
} from './run-isolated-functional-test.mjs'

test('each test run has a unique identity and disjoint private state paths', () => {
  const first = createRun(),
    second = createRun()
  assert.notEqual(first.runId, second.runId)
  assert.notEqual(first.appIdentity, second.appIdentity)
  assert.notEqual(first.paths.sqlite, second.paths.sqlite)
  assert.notEqual(first.paths.webviewData, second.paths.webviewData)
  assert.throws(() => createRun({ runId: '../production' }), /uuid/)
})

test('child process environment does not inherit production credentials or config redirections', () => {
  const run = createRun()
  const inherited = {
    SystemRoot: 'C:\\Windows',
    PATH: 'synthetic-path',
    APP_KEY: 'production',
    APP_CONFIG_CACHE: '/production',
    DB_URL: 'production',
    HTTP_PROXY: 'production',
    OPENAI_API_KEY: 'production',
    LUCZOR_JOB_PRIVATE_KEY_FILE: 'production',
    PHP_CLI_SERVER_WORKERS: '10',
    NODE_OPTIONS: 'production',
  }
  const env = isolatedEnvironment(run, '/backend', 8765, inherited)
  assert.equal(env.SystemRoot, inherited.SystemRoot)
  assert.equal(env.APP_ENV, 'testing')
  assert.equal(env.DB_CONNECTION, 'sqlite')
  assert.equal(env.APP_URL, 'http://127.0.0.1:8765')
  assert.equal(env.DB_DATABASE, run.paths.sqlite)
  assert.equal(env.LOG_CHANNEL, '"null"')
  for (const forbidden of [
    'DB_URL',
    'HTTP_PROXY',
    'OPENAI_API_KEY',
    'LUCZOR_JOB_PRIVATE_KEY_FILE',
    'PHP_CLI_SERVER_WORKERS',
    'NODE_OPTIONS',
  ])
    assert.equal(env[forbidden], undefined)
  assert.notEqual(env.APP_KEY, inherited.APP_KEY)
  assert.notEqual(env.APP_CONFIG_CACHE, inherited.APP_CONFIG_CACHE)
  assert.equal(inherited.APP_KEY, 'production')
  assert(!JSON.stringify(run).includes(env.APP_KEY))
})

test('an existing llama process waits only the model phase and never becomes success', () => {
  const run = applyResidentState(createRun(), [123])
  assert.deepEqual(run.phases.dream, { status: 'WAITING', reason: 'resident_model_busy' })
  assert.equal(run.phases.browser.status, 'NOT_RUN')
  assert.equal(run.phases.controlPlane.status, 'NOT_RUN')
})

test('model hook preserves independent dream, browser and aggregate cleanup outcomes', () => {
  const run = createRun()
  const result = {
    status: 'FAIL',
    reason: 'native_browser_probe_failed',
    dream: { status: 'PASS', receipts: [{}] },
    browserModel: { status: 'FAIL', reason: 'native_browser_probe_failed' },
  }
  applyModelResult(run, result)
  assert.equal(run.phases.dream.status, 'PASS')
  assert.equal(run.phases.browser.status, 'FAIL')
  assert.equal(run.modelRun.status, 'FAIL')
  const waiting = applyModelResult(createRun(), { status: 'WAITING', reason: 'resident_model_in_use' })
  assert.equal(waiting.phases.dream.status, 'WAITING')
  assert.equal(waiting.phases.browser.status, 'NOT_RUN')
})

test('bounded child terminates on timeout and does not return raw stderr', async () => {
  await assert.rejects(
    runBounded(process.execPath, ['-e', 'process.stderr.write("secret");setInterval(()=>{},1000)'], { timeoutMs: 150 }),
    error => !error.message.includes('secret') && /timed_out/.test(error.message)
  )
})

test('prepare creates empty isolated state, protects identity from reuse and leaves repo configuration untouched', async () => {
  const privateParent = await fs.mkdtemp(path.join(os.tmpdir(), 'luczor-isolation-unit-'))
  const run = createRun({ runId: randomUUID(), privateParent })
  try {
    await prepareRun(run)
    assert.equal(await fs.readFile(run.paths.sqlite, 'utf8'), '')
    assert.equal(await fs.readFile(path.join(run.runRoot, 'environment/.env'), 'utf8'), '')
    const config = JSON.parse(await fs.readFile(run.paths.tauriConfig, 'utf8'))
    assert.equal(config.identifier, run.appIdentity)
    assert.equal(config.app.windows[0].dataDirectory, 'isolated-browser')
    assert.equal(config.bundle.active, false)
    assert.equal(run.phases.isolation.status, 'PASS')
    await assert.rejects(prepareRun(run), /EEXIST/)
    assert.equal((await fs.readdir(run.runRoot)).includes('device-token.secret'), false)
  } finally {
    // Only this test-created, verified direct child of the system temp path.
    assert.equal(path.dirname(privateParent), os.tmpdir())
    await fs.rm(privateParent, { recursive: true, force: true })
  }
})
