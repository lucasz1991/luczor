/* eslint-disable @typescript-eslint/no-require-imports -- This .cjs test runs directly in Node's CommonJS test runner. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
/* eslint-enable @typescript-eslint/no-require-imports */

const root = path.join(__dirname, '..')
// eslint-disable-next-line security/detect-non-literal-fs-filename -- Read-only paths come from fixed cases and tracked packaging config, never runtime input.
const readText = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/gu, '\n')
const readJson = file => JSON.parse(readText(file))

const profiles = [
  { identifier: 'de.luczor.desktop', packageName: 'luczor', productName: 'Luczor', binary: 'tauri-app' },
  {
    identifier: 'de.luczor.desktop.local-test',
    packageName: 'luczor-local-test',
    productName: 'Luczor Local Test',
    binary: 'luczor-local-test',
  },
]

for (const [index, profile] of profiles.entries()) {
  test(`${profile.packageName} includes an isolated uninstall launcher and AppStream identity`, () => {
    const base = readJson('src-tauri/tauri.conf.json')
    const linux = readJson('src-tauri/tauri.linux.conf.json')
    const local = readJson('src-tauri/tauri.local-test.conf.json')
    const config = index ? local : base
    const files = new Map(Object.entries(index ? local.bundle.linux.deb.files : linux.bundle.linux.deb.files))
    assert.equal(config.identifier, profile.identifier)
    assert.equal(config.productName, profile.productName)
    if (index) assert.equal(config.mainBinaryName, profile.binary)
    else {
      assert.equal(config.mainBinaryName, undefined)
      assert.match(readText('src-tauri/Cargo.toml'), /\[package\]\s+name = "tauri-app"/u)
    }
    const helper = `/usr/share/${profile.identifier}/uninstall.sh`
    const launcher = `/usr/share/applications/${profile.identifier}.uninstall.desktop`
    const metainfo = `/usr/share/metainfo/${profile.identifier}.metainfo.xml`
    assert.equal(files.get(helper), '../scripts/uninstall-linux.sh')
    assert.equal(files.get(launcher), `linux/${profile.identifier}.uninstall.desktop`)
    assert.equal(files.get(metainfo), `linux/${profile.identifier}.metainfo.xml`)
    for (const source of [...files.values()].filter(value => value !== null))
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only inspect source files from the tracked package mapping; this call cannot mutate them.
      assert.ok(fs.statSync(path.resolve(root, 'src-tauri', source)).isFile(), source)

    const desktop = readText(`src-tauri/${files.get(launcher)}`)
    assert.match(desktop, /^Type=Application$/mu)
    assert.match(desktop, /^Terminal=true$/mu)
    assert.match(desktop, /^X-AppStream-Ignore=true$/mu)
    assert.ok(desktop.includes(`Name=${profile.productName} deinstallieren\n`))
    assert.ok(desktop.includes(`Exec=/bin/bash ${helper} --package ${profile.packageName} --desktop\n`))
    assert.ok(desktop.includes(`Icon=${profile.binary}\n`))
    const xml = readText(`src-tauri/${files.get(metainfo)}`)
    assert.match(xml, /<component type="desktop-application">/u)
    assert.ok(xml.includes(`<id>${profile.identifier}</id>`))
    assert.ok(xml.includes(`<launchable type="desktop-id">${profile.productName}.desktop</launchable>`))
    assert.ok(xml.includes(`<icon type="stock">${profile.binary}</icon>`))
    assert.ok(xml.includes(`<binary>${profile.binary}</binary>`))
    assert.match(xml, /<metadata_license>MIT<\/metadata_license>/u)
    assert.match(readText('LICENSE'), /^MIT License/u)
    if (index) {
      for (const destination of Object.keys(linux.bundle.linux.deb.files)) assert.equal(files.get(destination), null)
      assert.deepEqual(
        [...files.entries()]
          .filter(([, value]) => value !== null)
          .map(([key]) => key)
          .sort(),
        [helper, launcher, metainfo].sort()
      )
    }
  })
}

test('pinned Tauri parser deletes production map keys before validating the local-test overlay', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'luczor-tauri-packaging-'))
  try {
    const tauri = path.join(fixture, 'src-tauri')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed child of the test-owned mkdtemp directory.
    fs.mkdirSync(tauri)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed config filename inside the test-owned fixture.
    fs.writeFileSync(path.join(tauri, 'tauri.conf.json'), JSON.stringify(readJson('src-tauri/tauri.conf.json')))
    const linux = readJson('src-tauri/tauri.linux.conf.json')
    // Poison inherited values: only genuine Merge Patch deletion before native
    // schema validation can reach the deliberately invalid Cargo manifest below.
    linux.bundle.linux.deb.files = Object.fromEntries(
      Object.keys(linux.bundle.linux.deb.files).map(destination => [destination, { mustBeRemoved: true }])
    )
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed config filename inside the test-owned fixture.
    fs.writeFileSync(path.join(tauri, 'tauri.linux.conf.json'), JSON.stringify(linux))
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Deliberate invalid manifest prevents any compilation in this test-owned fixture.
    fs.writeFileSync(path.join(tauri, 'Cargo.toml'), '[luczor-config-probe\n')
    const overlay = path.join(fixture, 'local-test.json')
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed overlay filename inside the test-owned fixture.
    fs.writeFileSync(overlay, JSON.stringify(readJson('src-tauri/tauri.local-test.conf.json')))
    const cli = require.resolve('@tauri-apps/cli/tauri.js')
    const invalid = spawnSync(process.execPath, [cli, 'build', '--target', 'x86_64-unknown-linux-gnu', '--no-bundle'], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    assert.ifError(invalid.error)
    assert.notEqual(invalid.status, 0)
    assert.match(invalid.stdout + invalid.stderr, /tauri\.conf\.json.*error on.*files/iu)
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /luczor-config-probe/iu)
    const result = spawnSync(
      process.execPath,
      [cli, 'build', '--target', 'x86_64-unknown-linux-gnu', '--no-bundle', '--config', overlay],
      { cwd: fixture, encoding: 'utf8', timeout: 15_000, windowsHide: true }
    )
    assert.ifError(result.error)
    const output = result.stdout + result.stderr
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(output, /tauri\.conf\.json.*error on|mustBeRemoved|invalid type:.*map/iu)
    assert.match(output, /Cargo\.toml/iu)
    assert.match(output, /luczor-config-probe/iu)
  } finally {
    // The random fixture contains only files created by this test.
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(fixture).startsWith('luczor-tauri-packaging-'))
    fs.rmSync(fixture, { recursive: true, force: true })
  }
})

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
