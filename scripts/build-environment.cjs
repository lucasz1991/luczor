/* eslint-disable @typescript-eslint/no-require-imports, security/detect-non-literal-fs-filename -- Direct build launcher using the project pin and local NVM paths. */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function prependPath(env, directories, platform = process.platform) {
  const isPath = key => (platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH')
  const entries = Object.entries(env)
  const previous = entries.find(([key]) => isPath(key))?.[1] || ''
  return {
    ...Object.fromEntries(entries.filter(([key]) => !isPath(key))),
    [platform === 'win32' ? 'Path' : 'PATH']: [...directories, previous]
      .filter(Boolean)
      .join(platform === 'win32' ? ';' : ':'),
  }
}

function pinnedNodeEnvironment(root, options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    executable = process.execPath,
    version = process.versions.node,
    run = spawnSync,
  } = options
  const pin = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim()
  if (!/^22\.\d+\.\d+$/.test(pin)) throw new Error(`Invalid project Node pin: ${pin}`)
  let node = executable
  if (version !== pin) {
    const candidates =
      platform === 'win32'
        ? [env.NVM_HOME, env.APPDATA && path.join(env.APPDATA, 'nvm')]
            .filter(Boolean)
            .map(directory => path.join(directory, `v${pin}`, 'node.exe'))
        : [env.NVM_DIR && path.join(env.NVM_DIR, 'versions', 'node', `v${pin}`, 'bin', 'node')].filter(Boolean)
    node = [...new Set(candidates)].find(candidate => {
      if (!fs.existsSync(candidate)) return false
      const probe = run(candidate, ['-p', 'process.versions.node + "/" + process.arch'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        env,
      })
      return probe.status === 0 && probe.stdout.trim() === `${pin}/${arch}`
    })
    if (!node)
      throw new Error(
        `Node ${pin} (${arch}) is required; current Node is ${version}. Install the project version with nvm install ${pin}, then retry.`
      )
  }
  return {
    executable: node,
    reexec: version !== pin,
    version: pin,
    env: { ...prependPath(env, [path.dirname(node)], platform), npm_node_execpath: node },
  }
}

module.exports = { pinnedNodeEnvironment, prependPath }
