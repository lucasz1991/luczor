const assert = require('node:assert/strict')
const test = require('node:test')

test('managed Claude runtime is only enabled for Windows x64', async () => {
  const { supportsManagedClaudeRuntime } = await import('./agent-runtime-platform.mjs')
  assert.equal(supportsManagedClaudeRuntime('win32', 'x64'), true)
  assert.equal(supportsManagedClaudeRuntime('linux', 'x64'), false)
  assert.equal(supportsManagedClaudeRuntime('darwin', 'arm64'), false)
  assert.equal(supportsManagedClaudeRuntime('win32', 'arm64'), false)
})
