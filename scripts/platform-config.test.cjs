const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

test('Claude resource is Windows-only in the Tauri configuration', () => {
  const base = readJson('src-tauri/tauri.conf.json')
  const windows = readJson('src-tauri/tauri.windows.conf.json')
  assert.equal(base.bundle.resources, undefined)
  assert.deepEqual(windows.bundle.resources, {
    '../../.lmzdev/artifacts/runtime/claude-agent/': 'claude-agent/',
  })
})
