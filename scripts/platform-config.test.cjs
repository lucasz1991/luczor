const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

test('Claude resource is selected by the Tauri platform overlays', () => {
  const base = readJson('src-tauri/tauri.conf.json')
  const linux = readJson('src-tauri/tauri.linux.conf.json')
  const macos = readJson('src-tauri/tauri.macos.conf.json')
  const windows = readJson('src-tauri/tauri.windows.conf.json')
  assert.equal(base.bundle.resources, undefined)
  const resource = { '../../.lmzdev/artifacts/runtime/claude-agent/': 'claude-agent/' }
  assert.deepEqual(windows.bundle.resources, resource)
  assert.deepEqual(linux.bundle.resources, resource)
  assert.deepEqual(macos.bundle.resources, resource)
})
