/* eslint-disable @typescript-eslint/no-require-imports, security/detect-non-literal-fs-filename -- Build-only paths and pinned tool archives; no application input. */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { prependPath } = require('./build-environment.cjs')
const tools = require('./windows-voice-build-tools.json')

const defaultRoot = path.resolve(__dirname, '../../.lmzdev/artifacts/build/voice-tools')
const generators = new Map([
  ['16', 'Visual Studio 16 2019'],
  ['17', 'Visual Studio 17 2022'],
])

async function matchesHash(file, sha256, bytes) {
  try {
    if (bytes !== undefined && (await fsp.stat(file)).size !== bytes) return false
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    return hash.digest('hex') === sha256
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function preparePortableTool(
  tool,
  root = defaultRoot,
  request = fetch,
  run = spawnSync,
  archiveCommand = process.platform === 'win32' ? 'tar.exe' : 'tar'
) {
  const binary = path.join(root, tool.directory, tool.binary)
  const marker = path.join(root, tool.directory, '.luczor-verified')
  const prepared = await fsp.readFile(marker, 'utf8').catch(() => '')
  if (prepared === tool.sha256 && (await matchesHash(binary, tool.binarySha256))) return binary

  await fsp.mkdir(root, { recursive: true })
  const archive = path.join(root, tool.archive)
  if (!(await matchesHash(archive, tool.sha256, tool.bytes))) {
    console.log(`Preparing native Whisper build tool: ${tool.archive} …`)
    const partial = `${archive}.${process.pid}.part`
    try {
      const response = await request(tool.url, { signal: AbortSignal.timeout(300_000) })
      if (!response.ok || !response.body) throw new Error(`Build tool download failed: HTTP ${response.status}`)
      const output = await fsp.open(partial, 'w')
      let bytes = 0
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > tool.bytes) throw new Error(`Build tool exceeds pinned size: ${tool.archive}`)
          await output.writeFile(chunk)
        }
      } finally {
        await output.close()
      }
      if (!(await matchesHash(partial, tool.sha256, tool.bytes)))
        throw new Error(`Build tool checksum mismatch: ${tool.archive}`)
      await fsp.rename(partial, archive)
    } finally {
      await fsp.rm(partial, { force: true })
    }
  }
  const destination = path.join(root, tool.extractTo)
  await fsp.mkdir(destination, { recursive: true })
  // Only verified bytes reach the platform archive extractor.
  const extracted = run(archiveCommand, ['-xf', archive, '-C', destination], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  })
  if (extracted.error || extracted.status !== 0)
    throw new Error(`Cannot unpack ${tool.archive}: ${extracted.error?.message || extracted.stderr}`)
  if (!(await matchesHash(binary, tool.binarySha256)))
    throw new Error(`Extracted build tool checksum mismatch: ${tool.binary}`)
  await fsp.writeFile(marker, tool.sha256)
  return binary
}

function selectVisualStudio(instances, env, exists = fs.existsSync) {
  const candidates = instances
    .filter(instance => {
      const major = instance.installationVersion?.split('.')[0]
      if (!generators.has(major)) return false
      if (env.CMAKE_GENERATOR?.startsWith('Visual Studio') && env.CMAKE_GENERATOR !== generators.get(major))
        return false
      if (
        env.CMAKE_GENERATOR_INSTANCE &&
        path.resolve(env.CMAKE_GENERATOR_INSTANCE).toLowerCase() !==
          path.resolve(instance.installationPath).toLowerCase()
      )
        return false
      return exists(path.join(instance.installationPath, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'))
    })
    .sort((left, right) =>
      right.installationVersion.localeCompare(left.installationVersion, undefined, { numeric: true })
    )
  if (!candidates.length)
    throw new Error(
      'Whisper needs Visual Studio 2019/2022 C++ Build Tools and a Windows SDK. Install the "Desktop development with C++" workload, or correct CMAKE_GENERATOR / CMAKE_GENERATOR_INSTANCE.'
    )
  return candidates[0]
}

function discoverMsvc(env, run = spawnSync) {
  const vswhere = path.join(
    env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe'
  )
  const result = run(
    vswhere,
    ['-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-format', 'json', '-utf8'],
    {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env,
    }
  )
  if (result.error || result.status !== 0)
    throw new Error(
      'Cannot find Visual C++ Build Tools. Install Visual Studio Desktop development with C++ (including Windows SDK).'
    )
  const instance = selectVisualStudio(JSON.parse(result.stdout.replace(/^\uFEFF/, '')), env)
  const version = fs
    .readFileSync(
      path.join(instance.installationPath, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'),
      'utf8'
    )
    .trim()
  const msvcInclude = path.join(instance.installationPath, 'VC/Tools/MSVC', version, 'include')
  if (!fs.existsSync(path.join(msvcInclude, 'stdbool.h')))
    throw new Error('Visual C++ headers are incomplete; repair the Desktop development with C++ workload.')

  const registered = run(
    'reg.exe',
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots', '/v', 'KitsRoot10', '/reg:32'],
    {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      env,
    }
  )
  const kitRoot =
    env.WindowsSdkDir ||
    registered.stdout?.match(/KitsRoot10\s+REG_SZ\s+(.+)/)?.[1].trim() ||
    path.join(env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Windows Kits/10')
  const includeRoot = path.join(kitRoot, 'Include')
  const versions = fs.existsSync(includeRoot)
    ? fs
        .readdirSync(includeRoot)
        .filter(value => /^10\.\d+\.\d+\.\d+$/.test(value))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    : []
  const sdk = versions.find(value => fs.existsSync(path.join(includeRoot, value, 'ucrt/stdio.h')))
  if (!sdk)
    throw new Error(
      'Windows SDK UCRT headers are missing; install the Windows 10/11 SDK through Visual Studio Installer.'
    )
  return { instance, includes: [msvcInclude, path.join(includeRoot, sdk, 'ucrt')] }
}

function libclangDirectory(value) {
  const directory = fs.existsSync(value) && fs.statSync(value).isFile() ? path.dirname(value) : value
  if (!['libclang.dll', 'clang.dll'].some(file => fs.existsSync(path.join(directory, file))))
    throw new Error(`LIBCLANG_PATH has no libclang.dll: ${value}`)
  return directory
}

async function prepareWindowsVoiceBuild(env, options = {}) {
  const { platform = process.platform, arch = process.arch, target = '', root = defaultRoot, run = spawnSync } = options
  if (platform !== 'win32' || (target && !target.endsWith('windows-msvc'))) return env
  if (arch !== 'x64')
    throw new Error('Automatic Windows Whisper build preparation currently requires an x64 Node/Rust build host.')
  if (env.WHISPER_DONT_GENERATE_BINDINGS !== undefined)
    throw new Error('Remove WHISPER_DONT_GENERATE_BINDINGS: Whisper must generate Windows-specific bindings.')
  const { instance, includes } = discoverMsvc(env, run)
  const next = { ...env }
  if (!next.CMAKE_GENERATOR) next.CMAKE_GENERATOR = generators.get(instance.installationVersion.split('.')[0])
  if (next.CMAKE_GENERATOR.startsWith('Visual Studio')) next.CMAKE_GENERATOR_INSTANCE = instance.installationPath
  // Respect explicit developer configuration; otherwise use project-owned, checksum-pinned tools.
  const clang = next.LIBCLANG_PATH
    ? libclangDirectory(next.LIBCLANG_PATH)
    : path.dirname(await preparePortableTool(tools.libclang, root))
  const cmake = next.CMAKE || (await preparePortableTool(tools.cmake, root))
  const probe = run(cmake, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, env: next })
  if (probe.error || probe.status !== 0) throw new Error(`CMake is unavailable: ${cmake}`)
  next.CMAKE = cmake
  next.LIBCLANG_PATH = clang
  // The small libclang distribution has no resource headers; use the selected native Windows headers.
  next.BINDGEN_EXTRA_CLANG_ARGS = [
    next.BINDGEN_EXTRA_CLANG_ARGS,
    ...includes.map(include => `-isystem "${include.replaceAll('\\', '/')}"`),
  ]
    .filter(Boolean)
    .join(' ')
  console.log(`Windows Whisper build ready: ${next.CMAKE_GENERATOR}, CMake, libclang and Windows SDK.`)
  return prependPath(next, [path.dirname(cmake)], platform)
}

module.exports = {
  matchesHash,
  preparePortableTool,
  selectVisualStudio,
  discoverMsvc,
  libclangDirectory,
  prepareWindowsVoiceBuild,
}

// Also gives direct Cargo/CI checks the same build-only environment as Tauri.
if (require.main === module) {
  prepareWindowsVoiceBuild(process.env)
    .then(env => {
      const [command, ...args] = process.argv.slice(2)
      if (!command) return
      const result = spawnSync(command, args, { env, stdio: 'inherit', windowsHide: true })
      if (result.error) throw result.error
      process.exitCode = result.status ?? 1
    })
    .catch(error => {
      console.error(error.message)
      process.exitCode = 1
    })
}
