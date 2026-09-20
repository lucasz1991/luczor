/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS release-script tests. */
const assert = require('node:assert/strict')
const test = require('node:test')
const { checkLifecycle, PACKAGES, REMOVE_FLAG } = require('./check-debian-lifecycle.cjs')

function fixture(changes = {}) {
  const calls = []
  const files = new Map()
  const packageName = changes.profile || 'luczor'
  const owned = Object.entries(PACKAGES).find(([name]) => name === packageName)[1].files
  let removed = false
  const options = {
    env: { CI: 'true' },
    platform: 'linux',
    uid: 1001,
    home: '/home/ci',
    fs: {
      existsSync: file => (owned.includes(file) ? !removed || changes.leakedFile === file : files.has(file)),
      mkdirSync: () => {},
      writeFileSync: (file, data, options) => {
        assert.equal(options.flag, 'wx')
        files.set(file, data)
      },
      readFileSync: file => files.get(file),
    },
    run: (command, args) => {
      calls.push({ command, args })
      if (command === 'dpkg-deb') {
        if (args[0] === '--field')
          return { Package: changes.packageName || packageName, Version: '2.9.3', Architecture: 'amd64' }[args[2]]
        return owned
          .filter(file => file !== changes.missingFile)
          .map(file => `-rwxr-xr-x root/root 123 2026-09-20 12:00 .${file}`)
          .join('\n')
      }
      if (command === 'dpkg-query') {
        if (args[0] === '--show' && args.length === 2) {
          if (changes.queryFailure) throw new Error('database query failed')
          return changes.absentRow ? '' : `${packageName}\tconfig-files\n`
        }
        if (args[0] === '--show')
          return removed ? 'config-files' : `installed\n${changes.installedVersion || '2.9.3'}\namd64`
        if (args[0] === '--listfiles') return owned.join('\n')
        if (args[0] === '--search') return `${changes.owner || packageName}: ${args[1]}`
      }
      if (command === 'sudo' || command === 'apt-get') {
        removed = true
        if (changes.eraseUserdata) files.clear()
        return ''
      }
      throw new Error(`Unexpected command ${command}`)
    },
  }
  return { options, calls, files }
}

test('artifact inspection is read-only unless the explicit disposable CI removal flag is present', () => {
  const { options, calls, files } = fixture()
  const result = checkLifecycle(['luczor.deb'], options)
  assert.equal(result.removed, false)
  assert.equal(files.size, 0)
  assert.ok(calls.every(call => call.command === 'dpkg-deb'))
})

test('mutation guard rejects ordinary hosts and invalid CLI input before any command', () => {
  for (const override of [{ env: {} }, { platform: 'win32' }]) {
    const { options, calls } = fixture()
    assert.throws(() => checkLifecycle(['luczor.deb', REMOVE_FLAG], { ...options, ...override }), /requires Linux/)
    assert.equal(calls.length, 0)
  }
  const { options, calls } = fixture()
  assert.throws(() => checkLifecycle(['--purge', REMOVE_FLAG], options), /Usage/)
  assert.throws(() => checkLifecycle(['luczor.deb', REMOVE_FLAG, REMOVE_FLAG], options), /Usage/)
  assert.equal(calls.length, 0)
})

test('removes only the exact artifact package and verifies all owned files plus preserved user data', () => {
  const { options, calls, files } = fixture()
  const result = checkLifecycle(['luczor.deb', REMOVE_FLAG], options)
  assert.equal(result.removed, true)
  assert.equal(result.preservedFiles.length, 4)
  assert.equal(files.size, 4)
  assert.deepEqual(
    calls.filter(call => call.command === 'sudo'),
    [
      {
        command: 'sudo',
        args: ['--non-interactive', 'apt-get', 'remove', '-y', '--no-auto-remove', '--', 'luczor'],
      },
    ]
  )
})

test('checks and removes the independent local-test profile as root without touching the production package', () => {
  const { options, calls } = fixture({ profile: 'luczor-local-test', absentRow: true })
  const result = checkLifecycle(['luczor-local-test.deb', REMOVE_FLAG], { ...options, uid: 0 })
  assert.equal(result.packageName, 'luczor-local-test')
  assert.ok(result.preservedFiles.some(file => file.includes('de.luczor.desktop.local-test')))
  assert.deepEqual(
    calls.filter(call => call.command === 'apt-get'),
    [
      {
        command: 'apt-get',
        args: ['remove', '-y', '--no-auto-remove', '--', 'luczor-local-test'],
      },
    ]
  )
  assert.ok(!calls.some(call => call.args.includes('/usr/bin/tauri-app')))
})

test('refuses wrong package identity, missing launcher, version mismatch or foreign file ownership before removal', () => {
  for (const changes of [
    { packageName: 'unrelated-package' },
    { missingFile: '/usr/share/applications/Luczor.desktop' },
    { installedVersion: '0.0.1' },
    { owner: 'another-package' },
  ]) {
    const { options, calls } = fixture(changes)
    assert.throws(() => checkLifecycle(['luczor.deb', REMOVE_FLAG], options))
    assert.ok(!calls.some(call => call.command === 'sudo' || call.command === 'apt-get'))
  }
})

test('reports incomplete removal and damaged user data instead of claiming a successful uninstall', () => {
  const leaked = fixture({ leakedFile: '/usr/bin/tauri-app' })
  assert.throws(() => checkLifecycle(['luczor.deb', REMOVE_FLAG], leaked.options), /remains after removal/)
  const erased = fixture({ eraseUserdata: true })
  assert.throws(() => checkLifecycle(['luczor.deb', REMOVE_FLAG], erased.options), /User data changed/)
  const unreadable = fixture({ queryFailure: true })
  assert.throws(() => checkLifecycle(['luczor.deb', REMOVE_FLAG], unreadable.options), /database query failed/)
})
