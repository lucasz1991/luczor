const test = require('node:test')
const assert = require('node:assert/strict')

const { hasAuthenticodeCertificate } = require('./check-unsigned-pe.cjs')

function peFixture({ certificateOffset = 0, certificateSize = 0 } = {}) {
  const peOffset = 0x80
  const optionalHeaderOffset = peOffset + 24
  const securityDirectoryOffset = optionalHeaderOffset + 112 + 4 * 8
  const buffer = Buffer.alloc(securityDirectoryOffset + 8)
  buffer.write('MZ', 0, 'ascii')
  buffer.writeUInt32LE(peOffset, 0x3c)
  buffer.write('PE\0\0', peOffset, 'ascii')
  buffer.writeUInt16LE(0x20b, optionalHeaderOffset)
  buffer.writeUInt32LE(certificateOffset, securityDirectoryOffset)
  buffer.writeUInt32LE(certificateSize, securityDirectoryOffset + 4)
  return buffer
}

test('accepts a PE image without an Authenticode certificate table', () => {
  assert.equal(hasAuthenticodeCertificate(peFixture()), false)
})

test('detects a populated Authenticode certificate table', () => {
  assert.equal(hasAuthenticodeCertificate(peFixture({ certificateOffset: 4096, certificateSize: 512 })), true)
})

test('rejects non-PE input instead of treating it as unsigned', () => {
  assert.throws(() => hasAuthenticodeCertificate(Buffer.from('not an executable')), /valid PE/)
})
