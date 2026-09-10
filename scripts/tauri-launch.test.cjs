const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const {
  declaredWorkspaceDependencies,
  dynamicTauriConfig,
  freePort,
  missingWorkspaceDependencies,
  pnpmInvocation,
  runtimeManifestMatches,
  targetTripleFromArgs,
} = require('./tauri-launch.cjs')

test('uses another port without interrupting an existing server', async () => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const occupied = server.address().port
    assert.ok((await freePort(occupied)) > occupied)
    assert.equal(server.listening, true)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('keeps optional resources out of dev and adds them only for a prepared bundle', () => {
  assert.deepEqual(dynamicTauriConfig('http://127.0.0.1:1420', false), {
    build: { devUrl: 'http://127.0.0.1:1420' },
  })
  assert.deepEqual(dynamicTauriConfig(undefined, true), {
    bundle: {
      resources: { '../../.lmzdev/artifacts/runtime/claude-agent/': 'claude-agent/' },
    },
  })
})

test('reads an explicit target without confusing cargo arguments', () => {
  assert.equal(targetTripleFromArgs(['build', '--target', 'x86_64-unknown-linux-gnu'], {}), 'x86_64-unknown-linux-gnu')
  assert.equal(targetTripleFromArgs(['build', '-t', 'aarch64-apple-darwin'], {}), 'aarch64-apple-darwin')
  assert.equal(targetTripleFromArgs(['dev', '--', '--features', 'test'], {}), '')
})

test('accepts only a complete runtime for the selected native profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luczor-runtime-'))
  const profile = {
    platform: 'linux',
    arch: 'x64',
    nodeExecutable: 'node',
    cliExecutable: 'claude',
  }
  try {
    for (const file of ['node', 'claude', 'worker.mjs', 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs']) {
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '')
    }
    const manifest = {
      sdkVersion: '0.3.266',
      cliVersion: '2.1.266',
      platform: 'linux',
      arch: 'x64',
      nodeExecutable: 'node',
      cliExecutable: 'claude',
    }
    assert.equal(runtimeManifestMatches(manifest, profile, root), true)
    assert.equal(runtimeManifestMatches({ ...manifest, platform: 'win32' }, profile, root), false)
  } finally {
    const temporaryRoot = path.resolve(os.tmpdir())
    const resolved = path.resolve(root)
    assert.equal(resolved.startsWith(`${temporaryRoot}${path.sep}`), true)
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})

test('detects missing direct dependencies including scoped packages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luczor-dependencies-'))
  try {
    const installedManifest = path.join(root, 'node_modules/vue/package.json')
    fs.mkdirSync(path.dirname(installedManifest), { recursive: true })
    fs.writeFileSync(installedManifest, '{}')
    assert.deepEqual(missingWorkspaceDependencies(['vue', '@vue-flow/core'], root), ['@vue-flow/core'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('collects production and development dependencies without duplicates', () => {
  assert.deepEqual(
    declaredWorkspaceDependencies({
      dependencies: { vue: '1', shared: '1' },
      devDependencies: { vite: '1', shared: '1' },
    }),
    ['vue', 'shared', 'vite']
  )
})

test('uses the active pnpm executable and a cross-platform fallback', () => {
  assert.deepEqual(pnpmInvocation({ npm_execpath: '/tools/pnpm.cjs' }, 'linux'), {
    command: process.execPath,
    args: ['/tools/pnpm.cjs'],
  })
  assert.deepEqual(pnpmInvocation({}, 'linux'), { command: 'pnpm', args: [] })
  assert.deepEqual(pnpmInvocation({}, 'win32'), { command: 'pnpm.cmd', args: [] })
})
