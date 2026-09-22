/* eslint-disable @typescript-eslint/no-require-imports, security/detect-non-literal-fs-filename -- Isolated build-script fixtures. */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pinnedNodeEnvironment, prependPath } = require('./build-environment.cjs')
const {
  preparePortableTool,
  selectVisualStudio,
  libclangDirectory,
  prepareWindowsVoiceBuild,
} = require('./prepare-windows-voice-build.cjs')

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luczor-build-env-'))
  context.after(() => {
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'luczor-build-env-')))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('switches an old Node only in the build child and validates the executable architecture', context => {
  const root = fixture(context)
  fs.writeFileSync(path.join(root, '.nvmrc'), '22.22.0\n')
  const node = path.join(root, 'v22.22.0/node.exe')
  fs.mkdirSync(path.dirname(node))
  fs.writeFileSync(node, '')
  const env = { NVM_HOME: root, Path: 'existing-tools', npm_node_execpath: 'old-node' }
  const original = { ...env }
  const options = {
    env,
    platform: 'win32',
    arch: 'x64',
    version: '22.11.0',
    executable: 'old-node',
    run: () => ({ status: 0, stdout: '22.22.0/x64\n' }),
  }
  const selected = pinnedNodeEnvironment(root, options)
  assert.equal(selected.executable, node)
  assert.equal(selected.reexec, true)
  assert.equal(selected.env.Path, `${path.dirname(node)};existing-tools`)
  assert.equal(selected.env.npm_node_execpath, node)
  assert.deepEqual(env, original)
  assert.equal(pinnedNodeEnvironment(root, { ...options, version: '22.22.0', executable: node }).reexec, false)
  assert.throws(
    () => pinnedNodeEnvironment(root, { ...options, run: () => ({ status: 0, stdout: '22.22.0/arm64' }) }),
    /Node 22.22.0/
  )
})

test('does not accept a stale NVM executable with the wrong version', context => {
  const root = fixture(context)
  fs.writeFileSync(path.join(root, '.nvmrc'), '22.22.0')
  fs.mkdirSync(path.join(root, 'v22.22.0'))
  fs.writeFileSync(path.join(root, 'v22.22.0/node.exe'), '')
  assert.throws(
    () =>
      pinnedNodeEnvironment(root, {
        env: { NVM_HOME: root },
        platform: 'win32',
        version: '22.11.0',
        run: () => ({ status: 0, stdout: '22.11.0/x64' }),
      }),
    /Install the project version/
  )
})

test('normalizes Windows PATH keys so child_process cannot pick a stale duplicate', () => {
  const env = prependPath({ Path: 'old', PATH: 'stale', KEEP: 'yes' }, ['pinned'], 'win32')
  assert.deepEqual(env, { Path: 'pinned;old', KEEP: 'yes' })
  assert.deepEqual(prependPath({ PATH: '/bin' }, ['/node'], 'linux'), { PATH: '/node:/bin' })
})

test('uses the C++ VS instance and respects explicit generator/instance selection', () => {
  const old = { installationVersion: '16.11.10', installationPath: '/vs2019' }
  const latest = { installationVersion: '17.8.0', installationPath: '/vs2022' }
  const exists = file => !file.includes('vs2022')
  assert.equal(selectVisualStudio([latest, old], {}, exists), old)
  assert.equal(
    selectVisualStudio([latest, old], {}, () => true),
    latest
  )
  assert.equal(
    selectVisualStudio([latest, old], { CMAKE_GENERATOR: 'Visual Studio 16 2019' }, () => true),
    old
  )
  assert.throws(
    () => selectVisualStudio([old], { CMAKE_GENERATOR_INSTANCE: '/missing' }, () => true),
    /C\+\+ Build Tools/
  )
  assert.throws(() => selectVisualStudio([], {}), /Desktop development/)
})

test('validates an explicit Clang directory or DLL instead of hiding a broken override', context => {
  const root = fixture(context)
  assert.throws(() => libclangDirectory(root), /LIBCLANG_PATH/)
  const dll = path.join(root, 'libclang.dll')
  fs.writeFileSync(dll, 'fixture')
  assert.equal(libclangDirectory(dll), root)
  assert.equal(libclangDirectory(root), root)
})

test('leaves non-Windows builds unchanged and rejects Linux fallback bindings on Windows', async () => {
  const env = { KEEP: 'original' }
  assert.equal(await prepareWindowsVoiceBuild(env, { platform: 'linux' }), env)
  assert.equal(await prepareWindowsVoiceBuild(env, { platform: 'win32', target: 'x86_64-unknown-linux-gnu' }), env)
  await assert.rejects(
    prepareWindowsVoiceBuild({ WHISPER_DONT_GENERATE_BINDINGS: '1' }, { platform: 'win32', arch: 'x64' }),
    /Windows-specific bindings/
  )
})

test('verifies downloads before extraction, caches valid tools and repairs changed binaries', async context => {
  const root = fixture(context)
  const archive = Buffer.from('verified-archive')
  const binary = Buffer.from('verified-binary')
  const sha = value => createHash('sha256').update(value).digest('hex')
  const tool = {
    archive: 'fixture.zip',
    url: 'https://example.invalid/tool',
    bytes: archive.length,
    sha256: sha(archive),
    directory: 'fixture',
    extractTo: 'fixture',
    binary: 'tool.exe',
    binarySha256: sha(binary),
  }
  let downloads = 0
  let extractions = 0
  const request = async () => {
    downloads++
    return { ok: true, body: [archive] }
  }
  const run = (command, args) => {
    assert.equal(command, 'tar.exe')
    assert.equal(args[1], path.join(root, 'fixture.zip'))
    fs.writeFileSync(path.join(root, 'fixture/tool.exe'), binary)
    extractions++
    return { status: 0 }
  }
  const executable = await preparePortableTool(tool, root, request, run)
  await preparePortableTool(tool, root, request, run)
  assert.equal(downloads, 1)
  assert.equal(extractions, 1)
  fs.writeFileSync(executable, 'damaged')
  await preparePortableTool(tool, root, request, run)
  assert.equal(downloads, 1)
  assert.equal(extractions, 2)
})

test('rejects corrupt/truncated/oversized downloads without extracting or leaving partial files', async context => {
  const root = fixture(context)
  const tool = {
    archive: 'fixture.zip',
    url: 'https://example.invalid/tool',
    bytes: 3,
    sha256: '0'.repeat(64),
    directory: 'fixture',
    extractTo: 'fixture',
    binary: 'tool.exe',
    binarySha256: '0'.repeat(64),
  }
  for (const content of ['abc', 'a', 'abcd']) {
    await assert.rejects(
      preparePortableTool(
        tool,
        root,
        async () => ({ ok: true, body: [Buffer.from(content)] }),
        () => assert.fail('must not extract')
      ),
      /checksum mismatch|exceeds pinned size/
    )
    assert.deepEqual(fs.readdirSync(root), [])
  }
})
