const { execFileSync } = require('node:child_process')
const path = require('node:path')

const file = process.argv[2]
if (!file || path.extname(file) !== '.deb') throw new Error('Provide the built Luczor .deb package.')
const dependencies = execFileSync('dpkg-deb', ['--field', path.resolve(file), 'Depends'], {
  encoding: 'utf8',
  timeout: 10000,
})
const packages = dependencies.split(',').map(value => value.trim().split(/[\s(:]/)[0])
for (const required of ['gstreamer1.0-plugins-base', 'gstreamer1.0-plugins-good', 'gstreamer1.0-plugins-bad']) {
  if (!packages.includes(required)) throw new Error(`Installer is missing mandatory dependency: ${required}`)
}
console.log('Luczor Debian installer declares all mandatory multimedia plugins.')
