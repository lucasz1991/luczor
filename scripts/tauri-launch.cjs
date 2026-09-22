/* eslint-disable @typescript-eslint/no-require-imports -- Tauri's launcher executes directly in Node's CommonJS runtime. */
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawn, spawnSync } = require('node:child_process')
const { reportLinuxMedia } = require('./linux-media-check.cjs')
const { pinnedNodeEnvironment } = require('./build-environment.cjs')
const { prepareLinuxVoiceBuild } = require('./prepare-linux-voice-build.cjs')
const { prepareWindowsVoiceBuild } = require('./prepare-windows-voice-build.cjs')

const appRoot = path.resolve(__dirname, '..')
const managedRuntimeRoot = path.resolve(appRoot, '../.lmzdev/artifacts/runtime/claude-agent')
const managedRuntimeResource = '../../.lmzdev/artifacts/runtime/claude-agent/'

function declaredWorkspaceDependencies(manifest = require(path.join(appRoot, 'package.json'))) {
  return [...new Set([...Object.keys(manifest.dependencies || {}), ...Object.keys(manifest.devDependencies || {})])]
}

function missingWorkspaceDependencies(dependencies = declaredWorkspaceDependencies(), root = appRoot) {
  return dependencies.filter(dependency => !fs.existsSync(path.join(root, 'node_modules', dependency, 'package.json')))
}

function pnpmInvocation(env = process.env, platform = process.platform) {
  const npmExecPath = env.npm_execpath
  if (npmExecPath && path.basename(npmExecPath).toLowerCase().includes('pnpm')) {
    return { command: process.execPath, args: [npmExecPath] }
  }
  return { command: platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args: [] }
}

function ensureWorkspaceDependencies(env = process.env) {
  const missing = missingWorkspaceDependencies()
  if (missing.length === 0) return

  console.warn(`Luczor dependencies are incomplete (${missing.join(', ')}); restoring the locked workspace install.`)
  const invocation = pnpmInvocation(env)
  const result = spawnSync(invocation.command, [...invocation.args, 'install', '--frozen-lockfile'], {
    cwd: appRoot,
    env,
    stdio: 'inherit',
  })
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || `exit code ${result.status ?? 'unknown'}`
    throw new Error(`Luczor dependency installation failed: ${reason}`)
  }

  const remaining = missingWorkspaceDependencies()
  if (remaining.length > 0) {
    throw new Error(`Luczor dependencies remain unavailable after pnpm install: ${remaining.join(', ')}`)
  }
}

async function freePort(start = 1420, host = '127.0.0.1') {
  for (let port = start; port < start + 100; port++) {
    const available = await new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', error => {
        if (error.code === 'EADDRINUSE') resolve(false)
        else reject(error)
      })
      server.listen(port, host, () => server.close(() => resolve(true)))
    })
    if (available) return port
  }
  throw new Error('No free Luczor development port found.')
}

function targetTripleFromArgs(args, env = process.env) {
  if (env.TAURI_ENV_TARGET_TRIPLE) return env.TAURI_ENV_TARGET_TRIPLE
  const index = args.findIndex(value => value === '--target' || value === '-t')
  return index >= 0 ? args[index + 1] || '' : ''
}

function runtimeManifestMatches(manifest, profile, root = managedRuntimeRoot) {
  if (!manifest || !profile) return false
  if (
    manifest.sdkVersion !== '0.3.266' ||
    manifest.cliVersion !== '2.1.266' ||
    manifest.platform !== profile.platform ||
    manifest.arch !== profile.arch ||
    manifest.nodeExecutable !== profile.nodeExecutable ||
    manifest.cliExecutable !== profile.cliExecutable
  )
    return false
  return [
    profile.nodeExecutable,
    profile.cliExecutable,
    'worker.mjs',
    'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
  ].every(file => fs.existsSync(path.join(root, file)))
}

function readRuntimeManifest(root = managedRuntimeRoot) {
  try {
    const bytes = fs.readFileSync(path.join(root, 'runtime.json'))
    if (bytes.length > 16_384) return undefined
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

async function prepareManagedRuntime(args, env, strict) {
  const targetTriple = targetTripleFromArgs(args, env)
  const moduleUrl = pathToFileURL(path.join(__dirname, 'agent-runtime-platform.mjs')).href
  const { managedClaudeRuntimeProfile } = await import(moduleUrl)
  const profile = managedClaudeRuntimeProfile(process.platform, process.arch, targetTriple)
  if (!profile) return false
  if (runtimeManifestMatches(readRuntimeManifest(), profile)) return true

  const runtimeEnv = { ...env }
  if (targetTriple) runtimeEnv.TAURI_ENV_TARGET_TRIPLE = targetTriple
  const result = spawnSync(process.execPath, [path.join(__dirname, 'build-agent-runtime.mjs')], {
    cwd: appRoot,
    env: runtimeEnv,
    stdio: 'inherit',
  })
  if (result.error || result.status !== 0) {
    const message = result.error?.message || `exit code ${result.status ?? 'unknown'}`
    if (strict) throw new Error(`Managed Claude runtime preparation failed: ${message}`)
    console.warn(`Managed Claude runtime is unavailable for this development start: ${message}`)
    return false
  }
  return runtimeManifestMatches(readRuntimeManifest(), profile)
}

function dynamicTauriConfig(devUrl, includeManagedRuntime, includeLspRuntime = false) {
  const config = {}
  if (devUrl) config.build = { devUrl }
  if (includeManagedRuntime) config.bundle = { resources: { [managedRuntimeResource]: 'claude-agent/' } }
  if (includeLspRuntime)
    config.bundle = {
      resources: { ...config.bundle?.resources, '../../.lmzdev/artifacts/runtime/repository-lsp/': 'repository-lsp/' },
    }
  return config
}

function forwardChild(child) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal))
  }
  child.once('error', error => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 130 : 1)
  })
}

async function main() {
  const args = process.argv.slice(2)
  let env = { ...process.env }
  const command = args[0]
  const isHelp = args.includes('--help') || args.includes('-h')
  if (!isHelp && ['dev', 'build', 'bundle'].includes(command)) {
    const node = pinnedNodeEnvironment(appRoot)
    env = node.env
    if (node.reexec) {
      console.log(`Luczor build uses Node ${node.version} (current shell remains unchanged).`)
      forwardChild(spawn(node.executable, [__filename, ...args], { env, stdio: 'inherit', windowsHide: true }))
      return
    }
    env = await prepareWindowsVoiceBuild(env, { target: targetTripleFromArgs(args, env) })
    env = await prepareLinuxVoiceBuild(env, { target: targetTripleFromArgs(args, env) })
  }
  if (!isHelp && ['dev', 'build', 'bundle'].includes(command)) ensureWorkspaceDependencies(env)
  if (!isHelp && command === 'dev') reportLinuxMedia()
  let devUrl
  if (args[0] === 'dev') {
    const host = env.TAURI_DEV_HOST || '127.0.0.1'
    const port = await freePort(1420, host)
    env.LUCZOR_DEV_PORT = String(port)
    env.LUCZOR_DEV_BIND_HOST = host
    const urlHost = host.includes(':') ? `[${host}]` : host
    devUrl = `http://${urlHost}:${port}`
    console.log(`Luczor development server: http://${urlHost}:${port}`)
  }
  let includeManagedRuntime = false
  if (!isHelp && ['dev', 'build', 'bundle'].includes(command)) {
    const { prepareVoiceRuntime } = await import(pathToFileURL(path.join(__dirname, 'prepare-voice-runtime.mjs')).href)
    await prepareVoiceRuntime()
    includeManagedRuntime = await prepareManagedRuntime(args, env, command !== 'dev')
    const lsp = spawnSync(process.execPath, [path.join(__dirname, 'build-lsp-runtime.mjs')], {
      cwd: appRoot,
      env: { ...env, TAURI_ENV_TARGET_TRIPLE: targetTripleFromArgs(args, env) },
      stdio: 'inherit',
      windowsHide: true,
    })
    if (lsp.error || lsp.status !== 0) throw new Error('Repository LSP runtime preparation failed.')
  }
  const config = dynamicTauriConfig(
    devUrl,
    includeManagedRuntime && command !== 'dev',
    !isHelp && ['build', 'bundle'].includes(command)
  )
  if (Object.keys(config).length > 0) {
    const separator = args.indexOf('--')
    args.splice(separator < 0 ? args.length : separator, 0, '--config', JSON.stringify(config))
  }
  const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js')
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: 'inherit' })
  forwardChild(child)
}

module.exports = {
  declaredWorkspaceDependencies,
  dynamicTauriConfig,
  ensureWorkspaceDependencies,
  freePort,
  missingWorkspaceDependencies,
  pnpmInvocation,
  runtimeManifestMatches,
  targetTripleFromArgs,
}
if (require.main === module)
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
