#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const MODES = new Set(['node', 'local-test', 'production'])

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function parseVersion(value) {
  const match = String(value)
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)$/)
  return match ? match.slice(1).map(Number) : null
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function isPlaceholder(value) {
  return /(?:example\.(?:com|invalid)|change[-_ ]?me|placeholder|todo|localhost|127\.0\.0\.1)/i.test(String(value))
}

function hasTarget(targets, expected) {
  return targets === 'all' || (Array.isArray(targets) && targets.includes(expected))
}

function inspectProject({
  root = path.resolve(__dirname, '..'),
  mode = 'local-test',
  runtimeVersion = process.versions.node,
  environment = process.env,
} = {}) {
  if (!MODES.has(mode)) throw new Error(`Unsupported readiness mode: ${mode}`)

  const errors = []
  const warnings = []
  const packageJson = readJson(path.join(root, 'package.json'))
  const tauriConfig = readJson(path.join(root, 'src-tauri', 'tauri.conf.json'))
  const cargoManifest = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8')
  const rustRuntime = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8')
  const pin = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim()
  const pinVersion = parseVersion(pin)
  const actualVersion = parseVersion(runtimeVersion)

  if (!pinVersion || pinVersion[0] !== 22) errors.push('.nvmrc must pin a complete Node 22 version')
  if (!actualVersion || runtimeVersion !== pin) {
    errors.push(`runtime Node ${runtimeVersion} does not match the project pin ${pin}`)
  }
  if (pinVersion && compareVersions(pinVersion, [22, 12, 0]) < 0) {
    errors.push("the pinned Node version is below Vite's supported Node 22 range")
  }
  if (packageJson.engines?.node !== '>=22.12.0 <23') {
    errors.push('package.json must keep the supported Node range >=22.12.0 <23')
  }
  if (packageJson.packageManager !== 'pnpm@10.27.0') {
    errors.push('packageManager must stay pinned to pnpm@10.27.0')
  }

  const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1]
  const versions = [packageJson.version, tauriConfig.version, cargoVersion]
  if (new Set(versions).size !== 1) errors.push('package, Tauri and Cargo release versions differ')

  if (mode === 'node') return { mode, errors, warnings }

  if (tauriConfig.bundle?.active !== true) errors.push('Tauri bundling is disabled')
  if (!hasTarget(tauriConfig.bundle?.targets, 'nsis'))
    errors.push('the primary Tauri config does not permit NSIS bundles')

  const localConfig = readJson(path.join(root, 'src-tauri', 'tauri.local-test.conf.json'))
  if (localConfig.productName === tauriConfig.productName)
    errors.push('the local installer must use a distinct product name')
  if (localConfig.identifier === tauriConfig.identifier)
    errors.push('the local installer must use a distinct application identifier')
  if (!hasTarget(localConfig.bundle?.targets, 'nsis')) errors.push('the local installer overlay must target NSIS')
  if (localConfig.bundle?.windows?.nsis?.installMode !== 'currentUser') {
    errors.push('the local installer must use currentUser install mode')
  }
  if (localConfig.plugins?.updater || localConfig.bundle?.createUpdaterArtifacts) {
    errors.push('the local test overlay must not enable the production updater')
  }

  const updater = tauriConfig.plugins?.updater
  const updaterParts = {
    artifacts: tauriConfig.bundle?.createUpdaterArtifacts === true,
    endpoints: Array.isArray(updater?.endpoints) && updater.endpoints.length > 0,
    publicKey: typeof updater?.pubkey === 'string' && updater.pubkey.trim() !== '',
    dependency: /^tauri-plugin-updater\s*=/m.test(cargoManifest),
    runtime: /tauri_plugin_updater::Builder::new\(\)\.build\(\)/.test(rustRuntime),
  }
  const configuredUpdaterParts = Object.values(updaterParts).filter(Boolean).length

  if (mode === 'local-test') {
    if (configuredUpdaterParts > 0) {
      errors.push('the unsigned local installer path requires the production updater to be absent')
    } else {
      warnings.push('production updater is intentionally unavailable in this checkout')
    }
    warnings.push('local test installers are intentionally unsigned and must not be published')
    return { mode, errors, warnings }
  }

  for (const [name, present] of Object.entries(updaterParts)) {
    if (!present) errors.push(`production updater requirement missing: ${name}`)
  }
  for (const endpoint of updater?.endpoints ?? []) {
    if (!String(endpoint).startsWith('https://') || isPlaceholder(endpoint)) {
      errors.push('production updater endpoints must be concrete HTTPS URLs')
    }
  }
  if (updater?.pubkey && isPlaceholder(updater.pubkey)) {
    errors.push('production updater public key is a placeholder')
  }

  const requiredSecrets = [
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'WINDOWS_CERTIFICATE',
    'WINDOWS_CERTIFICATE_PASSWORD',
  ]
  for (const name of requiredSecrets) {
    if (!environment[name]) {
      errors.push(`production release secret missing: ${name}`)
    } else if (isPlaceholder(environment[name])) {
      errors.push(`production release secret is a placeholder: ${name}`)
    }
  }

  return { mode, errors, warnings }
}

function printResult(result) {
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`)
  for (const error of result.errors) console.error(`ERROR: ${error}`)
  if (result.errors.length === 0) console.log(`Release readiness (${result.mode}) passed.`)
}

function parseMode(argv) {
  const index = argv.indexOf('--mode')
  return index >= 0 ? argv[index + 1] : 'local-test'
}

if (require.main === module) {
  try {
    const result = inspectProject({ mode: parseMode(process.argv.slice(2)) })
    printResult(result)
    process.exitCode = result.errors.length === 0 ? 0 : 1
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = { compareVersions, inspectProject, parseVersion }
