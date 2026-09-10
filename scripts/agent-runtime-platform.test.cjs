const assert = require('node:assert/strict')
const test = require('node:test')

test('managed Claude runtime is only enabled for Windows x64', async () => {
  const { supportsManagedClaudeRuntime } = await import('./agent-runtime-platform.mjs')
  assert.equal(supportsManagedClaudeRuntime('win32', 'x64'), true)
  assert.equal(supportsManagedClaudeRuntime('linux', 'x64'), false)
  assert.equal(supportsManagedClaudeRuntime('darwin', 'arm64'), false)
  assert.equal(supportsManagedClaudeRuntime('win32', 'arm64'), false)
  assert.equal(supportsManagedClaudeRuntime('win32', 'x64', 'x86_64-unknown-linux-gnu'), false)
  assert.equal(supportsManagedClaudeRuntime('win32', 'x64', 'x86_64-pc-windows-msvc'), true)
  assert.equal(supportsManagedClaudeRuntime('win32', 'x64', 'aarch64-pc-windows-msvc'), false)
})

test('the runtime build script exits cleanly when its host is Linux', () => {
  const { spawnSync } = require('node:child_process')
  const root = require('node:path').join(__dirname, '..')
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "Object.defineProperty(process, 'platform', { value: 'linux' }); await import('./scripts/build-agent-runtime.mjs')",
    ],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /skipped for linux\/x64/u)
})
