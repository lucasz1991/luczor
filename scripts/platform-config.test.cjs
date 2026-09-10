const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '..')
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))

test('Debian packages require the WebKit multimedia plugins even without recommendations', () => {
  const dependencies = readJson('src-tauri/tauri.linux.conf.json').bundle.linux.deb.depends
  for (const dependency of ['gstreamer1.0-plugins-base', 'gstreamer1.0-plugins-good', 'gstreamer1.0-plugins-bad']) {
    assert.ok(dependencies.includes(dependency))
  }
})

test('optional Claude resources are not required by static Tauri configs', () => {
  const base = readJson('src-tauri/tauri.conf.json')
  const linux = readJson('src-tauri/tauri.linux.conf.json')
  const macos = readJson('src-tauri/tauri.macos.conf.json')
  const windows = readJson('src-tauri/tauri.windows.conf.json')
  assert.equal(base.bundle.resources, undefined)
  assert.equal(windows.bundle?.resources, undefined)
  assert.equal(linux.bundle.resources, undefined)
  assert.equal(macos.bundle.resources, undefined)
})
