#!/usr/bin/env node

const fs = require('node:fs')

function hasAuthenticodeCertificate(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('file is not a valid PE executable')
  }

  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset > buffer.length - 26 || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('file has no valid PE header')
  }

  const optionalHeaderOffset = peOffset + 24
  const magic = buffer.readUInt16LE(optionalHeaderOffset)
  const dataDirectoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : null
  if (dataDirectoryOffset === null) throw new Error('unsupported PE optional-header format')

  // IMAGE_DIRECTORY_ENTRY_SECURITY is data-directory entry 4. Unlike other
  // entries, its address is a file offset to the Authenticode certificate table.
  const securityDirectoryOffset = optionalHeaderOffset + dataDirectoryOffset + 4 * 8
  if (securityDirectoryOffset > buffer.length - 8) throw new Error('truncated PE data directory')

  const certificateOffset = buffer.readUInt32LE(securityDirectoryOffset)
  const certificateSize = buffer.readUInt32LE(securityDirectoryOffset + 4)
  return certificateOffset !== 0 || certificateSize !== 0
}

if (require.main === module) {
  try {
    const filename = process.argv[2]
    if (!filename) throw new Error('usage: node scripts/check-unsigned-pe.cjs <installer.exe>')
    if (hasAuthenticodeCertificate(fs.readFileSync(filename))) {
      throw new Error('installer contains an Authenticode certificate table')
    }
    console.log(`Unsigned PE certificate-table check passed: ${filename}`)
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = { hasAuthenticodeCertificate }
