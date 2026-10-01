import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.dirname(scriptRoot)
const workspaceRoot = path.dirname(appRoot)
export const SCHEMA = 'luczor-isolated-functional-v1'
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const phase = (status, reason) => ({ status, reason })

function baseEnvironment(inherited = process.env) {
  const safe = new Set([
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TZ',
  ])
  return Object.fromEntries(Object.entries(inherited).filter(([key]) => safe.has(key.toUpperCase())))
}

export function createRun({
  runId = randomUUID(),
  privateParent = path.join(os.tmpdir(), 'luczor-isolated-functional'),
} = {}) {
  if (!uuidPattern.test(runId)) throw new Error('run_id_must_be_uuid_v4')
  const runRoot = path.resolve(privateParent, runId)
  const appIdentity = `de.luczor.isolated.r${runId.replaceAll('-', '')}`
  const desktopDataParent =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'))
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library/Application Support')
        : (process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local/share'))
  const appData = path.join(desktopDataParent, appIdentity)
  return {
    schema: SCHEMA,
    runId,
    runRoot,
    appIdentity,
    createdAt: new Date().toISOString(),
    paths: {
      appData,
      webviewData: path.join(appData, 'main/isolated-browser'),
      syntheticStore: path.join(runRoot, 'synthetic-store'),
      sqlite: path.join(runRoot, 'control-plane.sqlite'),
      storage: path.join(runRoot, 'storage'),
      tauriConfig: path.join(runRoot, 'tauri.isolated.conf.json'),
    },
    phases: {
      isolation: phase('NOT_RUN', 'validation_pending'),
      controlPlane: phase('NOT_RUN', 'not_requested'),
      browser: phase('NOT_RUN', 'requires_native_browser_runner'),
      dream: phase('NOT_RUN', 'requires_model_runner'),
    },
  }
}

// Child environments never inherit application credentials/proxies/provider keys.
export function isolatedEnvironment(run, backendRoot, port, inherited = process.env) {
  const env = baseEnvironment(inherited)
  const cache = path.join(run.runRoot, 'cache')
  return {
    ...env,
    LUCZOR_ISOLATED_RUN_ID: run.runId,
    LUCZOR_ISOLATED_RUN_ROOT: run.runRoot,
    LUCZOR_ISOLATED_BACKEND_ROOT: backendRoot,
    APP_NAME: 'Luczor Isolated Functional Test',
    APP_ENV: 'testing',
    APP_DEBUG: 'false',
    APP_URL: `http://127.0.0.1:${port}`,
    APP_KEY: `base64:${randomBytes(32).toString('base64')}`,
    APP_CONFIG_CACHE: path.join(cache, 'config.php'),
    APP_SERVICES_CACHE: path.join(cache, 'services.php'),
    APP_PACKAGES_CACHE: path.join(cache, 'packages.php'),
    APP_ROUTES_CACHE: path.join(cache, 'routes.php'),
    APP_EVENTS_CACHE: path.join(cache, 'events.php'),
    LARAVEL_STORAGE_PATH: run.paths.storage,
    VIEW_COMPILED_PATH: path.join(run.paths.storage, 'framework/views'),
    DB_CONNECTION: 'sqlite',
    DB_DATABASE: run.paths.sqlite,
    DB_FOREIGN_KEYS: 'true',
    CACHE_DRIVER: 'array',
    CACHE_STORE: 'array',
    SESSION_DRIVER: 'array',
    SESSION_SECURE_COOKIE: 'false',
    QUEUE_CONNECTION: 'sync',
    QUEUE_FAILED_DRIVER: 'null',
    BROADCAST_DRIVER: '"null"',
    BROADCAST_CONNECTION: '"null"',
    MAIL_MAILER: 'array',
    FILESYSTEM_DISK: 'local',
    LOG_CHANNEL: '"null"',
    LOG_DEPRECATIONS_CHANNEL: '"null"',
    COGNEE_ENABLED: 'false',
    COGNEE_IMPROVE_ENABLED: 'false',
    LUCZOR_ALLOW_REGISTRATION: 'false',
    LUCZOR_MEMORY_NAMESPACE_KEY: randomBytes(32).toString('base64'),
    LUCZOR_MEMORY_LEDGER_KEY: randomBytes(32).toString('base64'),
  }
}

export async function assertRegularFile(filename) {
  const stat = await fs.lstat(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('expected_regular_file')
  return { path: await fs.realpath(filename), bytes: stat.size }
}

async function assertNoLinkedAncestors(directory) {
  let candidate = path.resolve(directory)
  while (true) {
    try {
      if ((await fs.lstat(candidate)).isSymbolicLink()) throw new Error('linked_directory_not_allowed')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(candidate)
    if (parent === candidate) return
    candidate = parent
  }
}

export async function runBounded(executable, args, { env = baseEnvironment(), cwd, timeoutMs = 30000 } = {}) {
  const child = spawn(executable, args, {
    env,
    cwd,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '',
    overflow = false
  child.stdout.on('data', data => {
    if (output.length + data.length <= 1024 * 1024) output += data.toString()
    else overflow = true
  })
  // Raw stderr can contain credentials. Only an exit code is returned on failure.
  child.stderr.resume()
  const timer = setTimeout(() => child.kill(), timeoutMs)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    if (code !== 0 || overflow) {
      let reason = 'isolated_child_failed_or_timed_out'
      try {
        const result = JSON.parse(output)
        const safeReasons = [
          'invalid_isolated_identity',
          'invalid_isolation_marker',
          'unsafe_isolated_path',
          'invalid_database_environment',
          'effective_config_mismatch',
          'effective_database_or_cache_mismatch',
          'refusing_nonempty_database',
          'isolated_migration_failed',
          'private_token_write_failed',
          'isolated_control_plane_failed',
        ]
        if (result.ok === false && safeReasons.includes(result.reason)) {
          reason = result.reason
          if (['environment', 'bootstrap', 'migrate', 'seed', 'token', 'http'].includes(result.stage))
            reason += `:${result.stage}`
          if (typeof result.exception === 'string' && /^[A-Za-z\\\\]+$/.test(result.exception))
            reason += `:${result.exception}`
          if (typeof result.source === 'string' && /^[A-Za-z]+\.php:\d+$/.test(result.source))
            reason += `:${result.source}`
        }
      } catch {
        /* Do not expose arbitrary child output. */
      }
      throw new Error(reason)
    }
    return output.trim()
  } finally {
    clearTimeout(timer)
  }
}

export async function detectResidentModels() {
  if (process.platform === 'win32') {
    const raw = await runBounded('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '@(Get-CimInstance Win32_Process -Filter "Name = \'llama-server.exe\'" -ErrorAction Stop | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress',
    ])
    const values = raw ? JSON.parse(raw) : []
    return (Array.isArray(values) ? values : [values]).filter(Number.isInteger)
  }
  const raw = await runBounded('ps', ['-eo', 'pid=,comm='])
  return raw.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(?:.*\/)?llama-server$/)
    return match ? [Number(match[1])] : []
  })
}

export function applyResidentState(run, pids) {
  if (pids.length) run.phases.dream = phase('WAITING', 'resident_model_busy')
  run.residentModelCount = pids.length
  return run
}

export function applyModelResult(run, result) {
  // Keep aggregate cleanup/start evidence, but do not mislabel a browser failure
  // as a failed dream, or a completed native browser test as NOT_RUN.
  run.modelRun = result
  run.phases.dream = result.dream ?? { status: result.status, reason: result.reason }
  if (result.browserModel) run.phases.browser = result.browserModel
  return run
}

export async function prepareRun(run) {
  await assertNoLinkedAncestors(run.runRoot)
  try {
    await fs.lstat(run.paths.appData)
    throw new Error('native_test_identity_already_exists')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await fs.mkdir(path.dirname(run.runRoot), { recursive: true, mode: 0o700 })
  await fs.mkdir(run.runRoot, { mode: 0o700 }) // Existing run identities are never reused.
  if (process.platform === 'win32') {
    await runBounded('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p='${run.runRoot.replaceAll("'", "''")}'; $acl=[System.Security.AccessControl.DirectorySecurity]::new(); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl -ErrorAction Stop`,
    ])
  }
  for (const directory of [
    run.paths.syntheticStore,
    run.paths.storage,
    'cache',
    'environment',
    'storage/framework/views',
    'storage/framework/cache/data',
    'storage/framework/sessions',
    'storage/logs',
    'storage/app',
  ]) {
    await fs.mkdir(path.isAbsolute(directory) ? directory : path.join(run.runRoot, directory), {
      recursive: true,
      mode: 0o700,
    })
  }
  await fs.writeFile(run.paths.sqlite, '', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(path.join(run.runRoot, 'environment/.env'), '', { flag: 'wx', mode: 0o600 })
  await fs.writeFile(path.join(run.runRoot, 'isolation.json'), JSON.stringify({ schema: SCHEMA, runId: run.runId }), {
    flag: 'wx',
    mode: 0o600,
  })
  await fs.writeFile(
    run.paths.tauriConfig,
    JSON.stringify(
      {
        identifier: run.appIdentity,
        productName: 'Luczor Isolated Test',
        app: {
          windows: [
            {
              label: 'main',
              title: `Luczor — isolierter Test ${run.runId.slice(0, 8)}`,
              dataDirectory: 'isolated-browser',
            },
          ],
        },
        bundle: { active: false },
      },
      null,
      2
    ),
    { flag: 'wx', mode: 0o600 }
  )
  run.phases.isolation = phase('PASS', 'unique_private_state_created')
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function processStartMarker(child) {
  if (process.platform !== 'win32') return child.spawnfile
  return runBounded('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `(Get-Process -Id ${child.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`,
  ])
}

async function stopOwned(child, marker) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (!marker || (await processStartMarker(child).catch(() => null)) !== marker)
    throw new Error('owned_process_identity_changed')
  child.kill()
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('owned_server_cleanup_timeout')), 5000).unref()),
  ])
}

export async function controlPlaneSmoke(run, { backendRoot, php = 'php' }) {
  const port = await freePort()
  const env = isolatedEnvironment(run, backendRoot, port)
  const router = path.join(scriptRoot, 'isolated-functional-control-plane.php')
  const initialized = JSON.parse(
    await runBounded(php, [router, 'initialize'], { env, cwd: run.runRoot, timeoutMs: 120000 })
  )
  if (!initialized.ok || initialized.runId !== run.runId || initialized.users !== 1)
    throw new Error('synthetic_identity_not_verified')
  const child = spawn(php, ['-S', `127.0.0.1:${port}`, '-t', path.join(run.runRoot, 'environment'), router], {
    env,
    cwd: run.runRoot,
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  })
  let marker
  const origin = `http://127.0.0.1:${port}`
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    marker = await processStartMarker(child)
    const deadline = Date.now() + 15000
    let healthy = false
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('isolated_server_exited')
      const response = await fetch(`${origin}/__isolated/status`, { signal: AbortSignal.timeout(1000) }).catch(
        () => null
      )
      if (response?.ok) {
        const state = await response.json()
        if (state.runId !== run.runId || state.users !== 1) throw new Error('loopback_identity_mismatch')
        healthy = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!healthy) throw new Error('isolated_server_health_timeout')
    const token = await fs.readFile(path.join(run.runRoot, 'device-token.secret'), 'utf8')
    const unauthorized = await fetch(`${origin}/api/v1/preferences`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    const authorized = await fetch(`${origin}/api/v1/preferences`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    if (unauthorized.status !== 401 || !authorized.ok) throw new Error('isolated_api_auth_failed')
    run.phases.controlPlane = {
      ...phase('PASS', 'synthetic_identity_and_api_auth_verified'),
      origin,
      anonymousStatus: unauthorized.status,
      authenticatedStatus: authorized.status,
    }
  } finally {
    await stopOwned(child, marker)
    run.controlPlaneStopped = true
    // The token never belongs in retained test evidence; no live client uses it.
    await fs.unlink(path.join(run.runRoot, 'device-token.secret')).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export async function main(args = process.argv.slice(2)) {
  let mode = 'validate',
    runId,
    php = 'php',
    modelSmoke = false,
    assetRoot = 'D:\\Luczor\\local-model-test'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--validate-only') mode = 'validate'
    else if (args[i] === '--prepare') mode = 'prepare'
    else if (args[i] === '--control-plane-smoke') mode = 'control-plane'
    else if (args[i] === '--run-id') runId = args[++i]
    else if (args[i] === '--php') php = args[++i]
    else if (args[i] === '--model-smoke') {
      modelSmoke = true
      if (mode === 'validate') mode = 'prepare'
    } else if (args[i] === '--asset-root') assetRoot = args[++i]
    else throw new Error('unknown_isolated_launcher_argument')
  }
  const run = createRun({ runId })
  const backendRoot = path.join(workspaceRoot, 'admin_api_app')
  await assertRegularFile(path.join(backendRoot, 'vendor/autoload.php'))
  await assertRegularFile(path.join(backendRoot, 'bootstrap/app.php'))
  try {
    applyResidentState(run, await detectResidentModels())
  } catch {
    run.residentModelCount = null
    run.phases.dream = phase('WAITING', 'resident_model_state_unknown')
  }
  run.phases.isolation = phase('PASS', 'prerequisites_validated_no_process_started')
  if (mode !== 'validate') {
    await prepareRun(run)
    try {
      if (mode === 'control-plane') await controlPlaneSmoke(run, { backendRoot, php })
    } catch (error) {
      run.phases.controlPlane = phase('FAIL', error.message)
      process.exitCode = 1
    }
    if (modelSmoke && run.residentModelCount === 0) {
      try {
        const { runIsolatedModelSmoke } = await import('./isolated-model-smoke.mjs')
        const result = await runIsolatedModelSmoke({
          runId: run.runId,
          privateRoot: run.runRoot,
          assetRoot,
          pinProfile: path.join(scriptRoot, 'local-model-test.profile.json'),
        })
        applyModelResult(run, result)
        if (result.status === 'FAIL') process.exitCode = 1
      } catch {
        run.phases.dream = phase('FAIL', 'isolated_model_hook_failed')
        process.exitCode = 1
      }
    }
    const report = path.join(workspaceRoot, '.lmzdev/artifacts/reports', `isolated-functional-${run.runId}.json`)
    await fs.mkdir(path.dirname(report), { recursive: true })
    await fs.writeFile(report, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' })
    run.reportPath = report
  }
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`)
  return run
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Isolated test setup failed; no production process was stopped.\n')
    process.exitCode = 1
  })
}
