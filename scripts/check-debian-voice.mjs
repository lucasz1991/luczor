import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { voiceModel } from './prepare-voice-runtime.mjs'

const file = resolve(process.argv[2] || '')
if (!file.endsWith('.deb')) throw new Error('Provide the built Luczor .deb package.')
const contents = execFileSync('dpkg-deb', ['--contents', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const entries = contents.split('\n').map(line => line.slice(line.indexOf('./')))
const models = entries.filter(entry => entry.endsWith(`/voice/${voiceModel.file}`))
if (models.length !== 1 || !entries.some(entry => entry.endsWith('/voice/LICENSES.txt')))
  throw new Error('Installer is missing the bundled Whisper model or licenses.')

const archive = spawn('dpkg-deb', ['--fsys-tarfile', file], { stdio: ['ignore', 'pipe', 'inherit'] })
const extract = spawn('tar', ['-xOf', '-', models[0]], { stdio: ['pipe', 'pipe', 'inherit'] })
archive.stdout.pipe(extract.stdin)
extract.stdin.on('error', () => archive.kill())
const completion = child =>
  new Promise((done, fail) => {
    child.once('error', fail)
    child.once('exit', code => (code === 0 ? done() : fail(new Error(`Archive verification failed (${code})`))))
  })
const pending = Promise.all([completion(archive), completion(extract)])
let size = 0
const hash = createHash('sha256')
for await (const bytes of extract.stdout) {
  size += bytes.length
  hash.update(bytes)
}
await pending
if (size !== voiceModel.bytes || hash.digest('hex') !== voiceModel.sha256)
  throw new Error('The packaged Whisper model does not match its pinned checksum.')
console.log('Actual DEB contains the complete verified offline Whisper model and licenses.')
