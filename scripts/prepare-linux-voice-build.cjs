/* eslint-disable @typescript-eslint/no-require-imports, security/detect-non-literal-fs-filename -- Build-only paths and pinned tool archives; no application input. */
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { prependPath } = require('./build-environment.cjs')
const { preparePortableTool } = require('./prepare-windows-voice-build.cjs')
const tools = require('./linux-voice-build-tools.json')

const defaultRoot = path.resolve(__dirname, '../../.lmzdev/artifacts/build/voice-tools')

function cmakeWorks(command, env, run = spawnSync) {
  const result = run(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env,
  })
  return !result.error && result.status === 0 && /^cmake version 3\./m.test(result.stdout || '')
}

async function prepareLinuxVoiceBuild(env, options = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    target = '',
    root = defaultRoot,
    request = fetch,
    run = spawnSync,
  } = options
  if (platform !== 'linux' || (target && !target.includes('linux'))) return env

  if (env.CMAKE) {
    if (!cmakeWorks(env.CMAKE, env, run)) throw new Error(`Configured CMake cannot be executed: ${env.CMAKE}`)
    return prependPath({ ...env }, [path.dirname(env.CMAKE)], platform)
  }
  if (cmakeWorks('cmake', env, run)) return env

  const tool = tools[arch]
  if (!tool) {
    throw new Error(
      `CMake is missing and automatic Linux preparation does not support host architecture ${arch}. Run bash scripts/setup-desktop.sh --install.`
    )
  }
  const cmake = await preparePortableTool(tool, root, request, run, 'tar')
  await fsp.chmod(cmake, 0o755)
  if (!fs.existsSync(cmake) || !cmakeWorks(cmake, env, run)) {
    throw new Error('The verified portable CMake binary cannot run on this Linux system. Run bash scripts/setup-desktop.sh --install.')
  }
  console.log(`Linux build uses verified portable CMake 3.31.10 (${arch}); no system installation required.`)
  return prependPath({ ...env, CMAKE: cmake }, [path.dirname(cmake)], platform)
}

module.exports = { cmakeWorks, prepareLinuxVoiceBuild }

if (require.main === module) {
  prepareLinuxVoiceBuild(process.env)
    .then(env => {
      const [command, ...args] = process.argv.slice(2)
      if (!command) return
      const result = spawnSync(command, args, { env, stdio: 'inherit' })
      if (result.error) throw result.error
      process.exitCode = result.status ?? 1
    })
    .catch(error => {
      console.error(error.message)
      process.exitCode = 1
    })
}
