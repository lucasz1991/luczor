import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const TYPE_SIZE = new Map([
  [0, 1],
  [1, 1],
  [2, 2],
  [3, 2],
  [4, 4],
  [5, 4],
  [6, 4],
  [7, 1],
  [10, 8],
  [11, 8],
  [12, 8],
])
const STRING_TYPE = 8
const ARRAY_TYPE = 9

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : ''
}

const file = argument('file').trim()
const requestedKeys = process.argv
  .flatMap((value, index) => (value === '--key' ? [String(process.argv[index + 1] ?? '').trim()] : []))
  .filter(Boolean)

if (!file || !isAbsolute(file)) throw new Error('--file must be an absolute GGUF path.')
if (requestedKeys.length === 0) throw new Error('Specify at least one --key.')

const descriptor = openSync(file, 'r')
let position = 0

function readBuffer(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Unsafe GGUF field length.')
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const bytes = readSync(descriptor, buffer, offset, length - offset, position + offset)
    if (bytes === 0) throw new Error('Unexpected end of GGUF metadata.')
    offset += bytes
  }
  position += length
  return buffer
}

function skip(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('Unsafe GGUF skip length.')
  position += length
}

function readU32() {
  return readBuffer(4).readUInt32LE(0)
}

function readU64() {
  const value = readBuffer(8).readBigUInt64LE(0)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GGUF integer exceeds JavaScript safe range.')
  return Number(value)
}

function readString(capture) {
  const length = readU64()
  if (!capture) {
    skip(length)
    return undefined
  }
  return readBuffer(length).toString('utf8')
}

function skipValue(type) {
  if (TYPE_SIZE.has(type)) {
    skip(TYPE_SIZE.get(type))
    return
  }
  if (type === STRING_TYPE) {
    readString(false)
    return
  }
  if (type === ARRAY_TYPE) {
    const elementType = readU32()
    const length = readU64()
    if (TYPE_SIZE.has(elementType)) {
      skip(TYPE_SIZE.get(elementType) * length)
      return
    }
    for (let index = 0; index < length; index += 1) skipValue(elementType)
    return
  }
  throw new Error(`Unsupported GGUF metadata type ${type}.`)
}

function readValue(type) {
  if (type === STRING_TYPE) return readString(true)
  if (type === 7) return readBuffer(1)[0] !== 0
  if (type === 4) return readBuffer(4).readUInt32LE(0)
  if (type === 5) return readBuffer(4).readInt32LE(0)
  if (type === 10) return readU64()
  if (type === 11) {
    const value = readBuffer(8).readBigInt64LE(0)
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return value.toString()
    }
    return Number(value)
  }
  throw new Error(`Requested GGUF metadata type ${type} is not supported for output.`)
}

try {
  if (readBuffer(4).toString('ascii') !== 'GGUF') throw new Error('Input is not a GGUF file.')
  const version = readU32()
  const tensorCount = readU64()
  const metadataCount = readU64()
  const wanted = new Set(requestedKeys)
  const values = {}

  for (let index = 0; index < metadataCount; index += 1) {
    const key = readString(true)
    const type = readU32()
    if (wanted.has(key)) values[key] = readValue(type)
    else skipValue(type)
  }

  for (const key of wanted) {
    if (!(key in values)) throw new Error(`GGUF metadata key is missing: ${key}`)
  }
  const hashes = Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, createHash('sha256').update(value, 'utf8').digest('hex')])
  )
  process.stdout.write(`${JSON.stringify({ version, tensor_count: tensorCount, values, sha256: hashes })}\n`)
} finally {
  closeSync(descriptor)
}
