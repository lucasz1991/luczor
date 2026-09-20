/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS release-script tests. */
/* eslint-disable security/detect-non-literal-fs-filename -- Test fixtures use generated paths within their own temporary directory and the fixed source script. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const script = path.join(__dirname, 'uninstall-linux.sh')
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'
const shellPath = value => value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)

function fixture(context, options = {}) {
  assert.ok(fs.existsSync(bash), 'Bash is required to exercise the real uninstall script')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luczor-uninstall-test-'))
  context.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('luczor-uninstall-test-'))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const bin = path.join(directory, 'bin')
  fs.mkdirSync(bin)
  const write = (name, content) => fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${content}\n`, { mode: 0o755 })
  const initial = options.packages ?? 'luczor\tinstalled\nluczor-local-test\tinstalled\n'
  const database = path.join(directory, 'packages')
  fs.writeFileSync(database, initial)
  const calls = path.join(directory, 'calls')
  fs.writeFileSync(calls, '')
  const sentinel = path.join(directory, 'personal-model.gguf')
  fs.writeFileSync(sentinel, 'keep model and user data')
  write('uname', 'printf "%s\\n" "${TEST_PLATFORM:-Linux}"')
  write('id', 'printf "%s\\n" "${TEST_UID:-1000}"')
  write(
    'dpkg-query',
    `
if [[ -f "$TEST_AFTER" && "\${TEST_POST_QUERY_ERROR:-0}" != 0 ]]; then exit "$TEST_POST_QUERY_ERROR"; fi
if [[ "\${TEST_QUERY_ERROR:-0}" != 0 ]]; then exit "$TEST_QUERY_ERROR"; fi
cat "$TEST_DATABASE"`
  )
  write(
    'sudo',
    `printf 'sudo\\n' >> "$TEST_CALLS"
if [[ "\${TEST_SUDO_ERROR:-0}" != 0 ]]; then exit "$TEST_SUDO_ERROR"; fi
exec "$@"`
  )
  write(
    'apt-get',
    `printf '%s\\n' "$@" >> "$TEST_CALLS"
if [[ "\${TEST_APT_ERROR:-0}" != 0 ]]; then exit "$TEST_APT_ERROR"; fi
touch "$TEST_AFTER"
if [[ "\${TEST_DECLINE:-0}" != 1 ]]; then
  selected="\${@: -1}"
  while IFS=$'\\t' read -r name state; do
    if [[ "$name" != "$selected" ]]; then printf '%s\\t%s\\n' "$name" "$state"; fi
  done < "$TEST_DATABASE" > "$TEST_DATABASE.next"
  mv "$TEST_DATABASE.next" "$TEST_DATABASE"
fi`
  )
  return {
    run(args = [], env = {}) {
      const result = spawnSync(
        bash,
        [
          '--noprofile',
          '--norc',
          '-c',
          'export PATH="$TEST_BIN:$PATH"; exec /bin/bash "$TEST_SCRIPT" "$@"',
          'uninstall-test',
          ...args,
        ],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            TEST_BIN: shellPath(bin),
            TEST_SCRIPT: shellPath(script),
            TEST_DATABASE: shellPath(database),
            TEST_CALLS: shellPath(calls),
            TEST_AFTER: shellPath(path.join(directory, 'after')),
            ...env,
          },
        }
      )
      assert.ifError(result.error)
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep model and user data')
      return { ...result, calls: fs.readFileSync(calls, 'utf8'), database: fs.readFileSync(database, 'utf8') }
    },
  }
}

test('checks installed state without requesting privileges or modifying packages', context => {
  const result = fixture(context).run(['--check'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Paket: luczor\n/)
  assert.equal(result.calls, '')
  assert.match(result.database, /luczor\tinstalled/)
})

test('removes exactly production through sudo and keeps the co-installed test package', context => {
  const result = fixture(context).run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.calls, 'sudo\n--no-auto-remove\nremove\n--\nluczor\n')
  assert.equal(result.database, 'luczor-local-test\tinstalled\n')
  assert.match(result.stdout, /Paket luczor ist entfernt/)
  assert.match(result.stdout, /Fenster-X blendet die App nur aus/)
})

test('local-test removal is explicit and never removes production', context => {
  const result = fixture(context).run(['--package', 'luczor-local-test', '--desktop'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.database, 'luczor\tinstalled\n')
  assert.equal(result.calls, 'sudo\n--no-auto-remove\nremove\n--\nluczor-local-test\n')
})

test('root uses apt directly without a second privilege boundary', context => {
  const result = fixture(context).run([], { TEST_UID: '0' })
  assert.equal(result.status, 0)
  assert.equal(result.calls, '--no-auto-remove\nremove\n--\nluczor\n')
})

for (const args of [
  ['--package', 'tauri-app'],
  ['--package', 'luczor; echo unsafe'],
  ['--package'],
  ['--yes'],
  ['--purge'],
]) {
  test(`rejects unsupported or malformed options ${JSON.stringify(args)}`, context => {
    const result = fixture(context).run(args)
    assert.equal(result.status, 2)
    assert.equal(result.calls, '')
  })
}

for (const status of ['not-installed', 'config-files']) {
  test(`already removed package (${status}) requires no mutation`, context => {
    const result = fixture(context, { packages: `luczor\t${status}\n` }).run()
    assert.equal(result.status, 0)
    assert.equal(result.calls, '')
  })
}

test('an absent production package does not implicitly remove local-test', context => {
  const result = fixture(context, { packages: 'luczor-local-test\tinstalled\n' }).run()
  assert.equal(result.status, 0)
  assert.equal(result.calls, '')
  assert.match(result.stdout, /nicht installiert oder bereits entfernt/)
})

test('a half-configured package can still be removed through apt', context => {
  const result = fixture(context, { packages: 'luczor\thalf-configured\n' }).run()
  assert.equal(result.status, 0)
  assert.match(result.calls, /remove/)
})

test('declining the apt confirmation is not reported as success', context => {
  const result = fixture(context).run([], { TEST_DECLINE: '1' })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /weiterhin installiert/)
  assert.doesNotMatch(result.stdout, /Paket luczor ist entfernt/)
})

for (const [variable, expected] of [
  ['TEST_QUERY_ERROR', 1],
  ['TEST_SUDO_ERROR', 1],
  ['TEST_APT_ERROR', 100],
  ['TEST_POST_QUERY_ERROR', 1],
]) {
  test(`propagates ${variable} without claiming a completed uninstall`, context => {
    const result = fixture(context).run([], { [variable]: String(expected) })
    assert.equal(result.status, expected)
    assert.doesNotMatch(result.stdout, /Paket luczor ist entfernt/)
  })
}

test('refuses an unsupported host', context => {
  const result = fixture(context).run([], { TEST_PLATFORM: 'Darwin' })
  assert.equal(result.status, 2)
  assert.equal(result.calls, '')
})

test('refuses an unknown package state', context => {
  const result = fixture(context, { packages: 'luczor\tunexpected\n' }).run()
  assert.equal(result.status, 1)
  assert.equal(result.calls, '')
})
