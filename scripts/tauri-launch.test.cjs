const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { checkLinuxMedia, reportLinuxMedia } = require('./linux-media-check.cjs')

test('Linux media probes are bounded and are skipped on other hosts', () => {
  const calls = []
  const run = (command, args, options) => {
    calls.push(args[0])
    assert.equal(command, 'gst-inspect-1.0')
    assert.equal(options.timeout, 5000)
    return { status: 0 }
  }
  assert.deepEqual(checkLinuxMedia('win32', run), [])
  assert.deepEqual(checkLinuxMedia('darwin', run), [])
  assert.deepEqual(calls, [])
  assert.deepEqual(checkLinuxMedia('linux', run), [])
  assert.deepEqual(calls, ['fakevideosink', 'webvttenc'])
})

test('missing plugins have an actionable media repair without claiming a model failure', () => {
  const warnings = []
  const missing = reportLinuxMedia(
    'linux',
    (_, args) => ({ status: args[0] === 'webvttenc' ? 1 : 0 }),
    text => warnings.push(text)
  )
  assert.deepEqual(missing, ['webvttenc'])
  assert.match(warnings[0], /--install-media/)
  assert.match(warnings[0], /not model RAM\/VRAM/)
})

test('missing inspector, timeouts and terminated probes do not report multimedia ready', () => {
  assert.deepEqual(
    checkLinuxMedia('linux', () => ({ error: { code: 'ENOENT' } })),
    ['gst-inspect-1.0 (GStreamer tools)']
  )
  assert.deepEqual(
    checkLinuxMedia('linux', () => ({ error: { code: 'ETIMEDOUT' } })),
    ['fakevideosink', 'webvttenc']
  )
  assert.deepEqual(
    checkLinuxMedia('linux', () => ({ status: null, signal: 'SIGTERM' })),
    ['fakevideosink', 'webvttenc']
  )
})
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
  assert.deepEqual(dynamicTauriConfig(undefined, false, true), {
    bundle: { resources: { '../../.lmzdev/artifacts/runtime/repository-lsp/': 'repository-lsp/' } },
  })
  assert.deepEqual(dynamicTauriConfig('http://127.0.0.1:1420', false), {
    build: { devUrl: 'http://127.0.0.1:1420' },
  })
  assert.deepEqual(dynamicTauriConfig(undefined, true), {
    bundle: {
      resources: { '../../.lmzdev/artifacts/runtime/claude-agent/': 'claude-agent/' },
    },
  })
})

test(
  'real managed LSP resolves cross-file references without project configuration',
  { skip: process.env.LUCZOR_LSP_SMOKE !== '1', timeout: 90000 },
  () => {
    const { spawnSync } = require('node:child_process')
    const runtime = path.resolve(__dirname, '../../.lmzdev/artifacts/runtime/repository-lsp')
    const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), 'luczor-lsp-smoke-'))
    try {
      const output = spawnSync(
        path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'),
        [path.join(runtime, 'worker.mjs'), snapshot],
        {
          input: JSON.stringify({
            files: [
              {
                path: 'math.ts',
                content: 'export function add(a: number, b: number) { return a + b }\n',
                hash: 'fixture-a',
              },
              {
                path: 'main.ts',
                content: 'import { add } from "./math";\nexport const result = add(1, 2);\n',
                hash: 'fixture-b',
              },
            ],
          }),
          encoding: 'utf8',
          timeout: 75000,
          windowsHide: true,
        }
      )
      assert.equal(output.status, 0, output.stderr)
      const result = JSON.parse(output.stdout)
      assert.equal(result.status, 'ready')
      assert.equal(result.scanned, 2)
      assert.ok(
        result.edges.some(
          edge =>
            edge.source === 'main.ts' && edge.target === 'math.ts' && edge.symbol === 'add' && edge.source_line === 2
        ),
        JSON.stringify(result)
      )
      assert.ok(result.edges.every(edge => ['math.ts', 'main.ts'].includes(edge.target)))
    } finally {
      assert.ok(snapshot.startsWith(path.join(os.tmpdir(), 'luczor-lsp-smoke-')))
      fs.rmSync(snapshot, { recursive: true, force: true })
    }
  }
)

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
