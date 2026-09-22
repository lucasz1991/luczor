/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS release script. */
// Read-only by default. Package removal is opt-in and restricted to disposable CI.
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REMOVE_FLAG = '--remove-installed-package-on-disposable-system'
const PACKAGES = Object.freeze({
  luczor: {
    identifier: 'de.luczor.desktop',
    files: [
      '/usr/bin/tauri-app',
      '/usr/share/applications/Luczor.desktop',
      '/usr/share/applications/de.luczor.desktop.uninstall.desktop',
      '/usr/share/de.luczor.desktop/uninstall.sh',
      '/usr/share/metainfo/de.luczor.desktop.metainfo.xml',
    ],
  },
  'luczor-local-test': {
    identifier: 'de.luczor.desktop.local-test',
    files: [
      '/usr/bin/luczor-local-test',
      '/usr/share/applications/Luczor Local Test.desktop',
      '/usr/share/applications/de.luczor.desktop.local-test.uninstall.desktop',
      '/usr/share/de.luczor.desktop.local-test/uninstall.sh',
      '/usr/share/metainfo/de.luczor.desktop.local-test.metainfo.xml',
    ],
  },
})

function command(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024, ...options })
}

function inspectArtifact(file, run = command) {
  if (!file || path.extname(file) !== '.deb') throw new Error('Provide exactly one built Luczor .deb artifact.')
  const artifact = path.resolve(file)
  const field = name => run('dpkg-deb', ['--field', artifact, name]).trim()
  const packageName = field('Package')
  const definition = Object.entries(PACKAGES).find(([name]) => name === packageName)?.[1]
  if (!definition) throw new Error(`Unexpected Debian package identity: ${packageName}`)
  const version = field('Version')
  const architecture = field('Architecture')
  if (!version || !['amd64', 'arm64'].includes(architecture))
    throw new Error('Invalid artifact version or architecture.')
  const contents = run('dpkg-deb', ['--contents', artifact])
  const files = contents.split('\n').flatMap(line => {
    const match = /^-\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(?:\.\/)?(.+)$/u.exec(line)
    return match ? [`/${match[1]}`] : []
  })
  for (const expected of definition.files) {
    if (!files.includes(expected)) throw new Error(`Artifact lacks required regular file: ${expected}`)
  }
  return { packageName, version, architecture, ...definition }
}

function verifyInstalled(artifact, run, io) {
  const status = run('dpkg-query', [
    '--show',
    '--showformat=${db:Status-Status}\n${Version}\n${Architecture}',
    artifact.packageName,
  ])
  if (status.trim() !== `installed\n${artifact.version}\n${artifact.architecture}`)
    throw new Error('Installed package does not exactly match this artifact.')
  const listed = run('dpkg-query', ['--listfiles', artifact.packageName]).trim().split('\n')
  for (const file of artifact.files) {
    if (!listed.includes(file) || !io.existsSync(file)) throw new Error(`Installed package file missing: ${file}`)
    const owners = run('dpkg-query', ['--search', file]).trim().split('\n')
    const expected = [`${artifact.packageName}: ${file}`, `${artifact.packageName}:${artifact.architecture}: ${file}`]
    if (owners.length !== 1 || !expected.includes(owners[0]))
      throw new Error(`Unexpected installed file owner: ${file}`)
  }
}

function seedUserdata(identifier, home, env, io) {
  const marker = `luczor-uninstall-ci-${crypto.randomUUID()}`
  const directories = [
    [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), identifier), 'settings.json'],
    [path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), identifier), 'chat-memory-models.json'],
    [path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), identifier), 'model.bin'],
    [path.join(home, 'Luczor CI external models'), 'external-model.bin'],
  ]
  return directories.map(([directory, filename], index) => {
    const folder = path.join(directory, marker)
    io.mkdirSync(folder, { recursive: true })
    const file = path.join(folder, filename)
    const content = `Synthetic preserved Luczor user data ${marker} ${index}\n`
    io.writeFileSync(file, content, { flag: 'wx' })
    return { file, content }
  })
}

function checkLifecycle(args, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const run = options.run ?? command
  const io = options.fs ?? fs
  const home = options.home ?? os.homedir()
  const remove = args.includes(REMOVE_FLAG)
  const files = args.filter(argument => argument !== REMOVE_FLAG)
  if (files.length !== 1 || files[0].startsWith('-') || args.filter(argument => argument === REMOVE_FLAG).length > 1)
    throw new Error(`Usage: node scripts/check-debian-lifecycle.cjs artifact.deb [${REMOVE_FLAG}]`)
  if (remove && (platform !== 'linux' || env.CI !== 'true'))
    throw new Error('Package removal requires Linux, CI=true and the explicit disposable-system flag.')
  const artifact = inspectArtifact(files[0], run)
  if (!remove) return { packageName: artifact.packageName, removed: false, preservedFiles: [] }
  verifyInstalled(artifact, run, io)
  const sentinels = seedUserdata(artifact.identifier, home, env, io)
  // Only this allowlisted, inspected package is removed. No purge or autoremove.
  const aptArguments = ['apt-get', 'remove', '-y', '--no-auto-remove', '--', artifact.packageName]
  if ((options.uid ?? process.getuid?.()) === 0) run(aptArguments[0], aptArguments.slice(1), { timeout: 180000 })
  else run('sudo', ['--non-interactive', ...aptArguments], { timeout: 180000 })
  // Query the whole database: an absent row is normal, a failed database query is not.
  const statuses = run('dpkg-query', ['--show', '--showformat=${binary:Package}\t${db:Status-Status}\n'])
    .trim()
    .split('\n')
    .map(row => row.split('\t'))
    .filter(([name]) => name === artifact.packageName || name.startsWith(`${artifact.packageName}:`))
  for (const [, status] of statuses) {
    if (!['not-installed', 'config-files'].includes(status))
      throw new Error(`Package removal did not complete: ${status}`)
  }
  for (const file of artifact.files) {
    if (io.existsSync(file)) throw new Error(`Package-owned file remains after removal: ${file}`)
  }
  for (const sentinel of sentinels) {
    if (io.readFileSync(sentinel.file, 'utf8') !== sentinel.content)
      throw new Error(`User data changed during removal: ${sentinel.file}`)
  }
  return { packageName: artifact.packageName, removed: true, preservedFiles: sentinels.map(item => item.file) }
}

module.exports = { checkLifecycle, inspectArtifact, PACKAGES, REMOVE_FLAG }
if (require.main === module) {
  try {
    console.log(JSON.stringify(checkLifecycle(process.argv.slice(2)), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
