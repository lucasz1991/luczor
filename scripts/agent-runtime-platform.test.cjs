const assert = require('node:assert/strict')
const test = require('node:test')

test('managed Claude runtime selects the matching native profile', async () => {
  const { managedClaudeRuntimeProfile, supportsManagedClaudeRuntime } = await import('./agent-runtime-platform.mjs')
  assert.equal(supportsManagedClaudeRuntime('win32', 'x64'), true)
  assert.deepEqual(managedClaudeRuntimeProfile('win32', 'x64'), {
    packageName: '@anthropic-ai/claude-agent-sdk-win32-x64',
    cliExecutable: 'claude.exe',
    nodeExecutable: 'node.exe',
    platform: 'win32',
    arch: 'x64',
    libc: undefined,
  })
  assert.equal(supportsManagedClaudeRuntime('linux', 'x64'), true)
  assert.deepEqual(managedClaudeRuntimeProfile('linux', 'x64'), {
    packageName: '@anthropic-ai/claude-agent-sdk-linux-x64',
    cliExecutable: 'claude',
    nodeExecutable: 'node',
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
  })
  assert.equal(
    managedClaudeRuntimeProfile('linux', 'x64', 'x86_64-unknown-linux-musl').packageName,
    '@anthropic-ai/claude-agent-sdk-linux-x64-musl'
  )
  assert.equal(supportsManagedClaudeRuntime('darwin', 'arm64'), true)
  assert.equal(supportsManagedClaudeRuntime('win32', 'arm64'), false)
  assert.equal(supportsManagedClaudeRuntime('win32', 'x64', 'x86_64-unknown-linux-gnu'), false)
  assert.equal(supportsManagedClaudeRuntime('win32', 'x64', 'x86_64-pc-windows-msvc'), true)
  assert.equal(supportsManagedClaudeRuntime('win32', 'x64', 'aarch64-pc-windows-msvc'), false)
})

test('the runtime build script exits cleanly for an unsupported host', () => {
  const { spawnSync } = require('node:child_process')
  const root = require('node:path').join(__dirname, '..')
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "Object.defineProperty(process, 'platform', { value: 'freebsd' }); await import('./scripts/build-agent-runtime.mjs')",
    ],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /skipped for freebsd\/x64/u)
})

test('the runtime build script keeps a Linux build usable when its optional package is absent', () => {
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
  assert.match(result.stderr, /optional package .*linux-x64 is not installed/u)
})
