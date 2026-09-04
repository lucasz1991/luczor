const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const { compareVersions, inspectProject, parseVersion } = require('./release-readiness.cjs')

const projectRoot = path.resolve(__dirname, '..')

test('parses and compares complete semantic versions', () => {
  assert.deepEqual(parseVersion('v22.22.0'), [22, 22, 0])
  assert.equal(parseVersion('22.22'), null)
  assert.ok(compareVersions([22, 22, 0], [22, 12, 0]) > 0)
})

test('accepts the pinned runtime and isolated unsigned local installer contract', () => {
  const result = inspectProject({ root: projectRoot, mode: 'local-test', runtimeVersion: '22.22.0' })
  assert.deepEqual(result.errors, [])
  assert.ok(result.warnings.some(warning => warning.includes('unsigned')))
})

test('rejects an unpinned runtime and incomplete production release', () => {
  const nodeResult = inspectProject({ root: projectRoot, mode: 'node', runtimeVersion: '22.11.0' })
  assert.ok(nodeResult.errors.some(error => error.includes('does not match')))

  const productionResult = inspectProject({
    root: projectRoot,
    mode: 'production',
    runtimeVersion: '22.22.0',
    environment: {},
  })
  assert.ok(productionResult.errors.some(error => error.includes('updater requirement missing')))
  assert.ok(productionResult.errors.some(error => error.includes('release secret missing')))
  assert.ok(productionResult.errors.some(error => error.includes('local-model manifest key id')))
  assert.ok(productionResult.errors.some(error => error.includes('local-model manifest public key')))

  const placeholderResult = inspectProject({
    root: projectRoot,
    mode: 'production',
    runtimeVersion: '22.22.0',
    environment: {
      TAURI_SIGNING_PRIVATE_KEY: 'change-me',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'change-me',
      WINDOWS_CERTIFICATE: 'change-me',
      WINDOWS_CERTIFICATE_PASSWORD: 'change-me',
    },
  })
  assert.ok(placeholderResult.errors.some(error => error.includes('is a placeholder')))
})

test('validates the public local-model trust anchor and paired absolute runtime paths', () => {
  const publicPem = require('node:fs').readFileSync(
    path.join(projectRoot, 'tests', 'fixtures', 'local-model-manifest-test-public.pem'),
    'utf8'
  )
  const result = inspectProject({
    root: projectRoot,
    mode: 'production',
    runtimeVersion: '22.22.0',
    environment: {
      LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID: 'luczor-local-model-2026-01',
      LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64: Buffer.from(publicPem).toString('base64'),
      LUCZOR_LLAMA_CPP_BIN: 'relative/llama-server',
      LUCZOR_LOCAL_MODEL_DIR: 'D:\\models',
    },
  })
  expectErrors(result.errors)
  assert.ok(result.errors.some(error => error.includes('paths must be absolute')))
  assert.ok(!result.errors.some(error => error.includes('manifest key id')))
  assert.ok(!result.errors.some(error => error.includes('manifest public key')))

  const invalidPem = inspectProject({
    root: projectRoot,
    mode: 'production',
    runtimeVersion: '22.22.0',
    environment: {
      LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID: 'luczor-local-model-2026-01',
      LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64: Buffer.from(
        '-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n'
      ).toString('base64'),
    },
  })
  assert.ok(invalidPem.errors.some(error => error.includes('manifest public key')))

  for (const publicKey of [
    crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey,
    crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey,
  ]) {
    const rejected = inspectProject({
      root: projectRoot,
      mode: 'production',
      runtimeVersion: '22.22.0',
      environment: {
        LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID: 'luczor-local-model-2026-01',
        LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64: Buffer.from(
          publicKey.export({ type: 'spki', format: 'pem' })
        ).toString('base64'),
      },
    })
    assert.ok(rejected.errors.some(error => error.includes('manifest public key')))
  }

  const pkcs1 = crypto
    .generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ type: 'pkcs1', format: 'pem' })
  for (const invalidEncoding of [
    Buffer.from(pkcs1).toString('base64'),
    `${Buffer.from(publicPem).toString('base64').slice(0, 40)}\n${Buffer.from(publicPem)
      .toString('base64')
      .slice(40)}`,
    Buffer.from(`${publicPem}garbage`).toString('base64'),
    Buffer.from(publicPem).toString('base64').replace(/=+$/, ''),
  ]) {
    const rejected = inspectProject({
      root: projectRoot,
      mode: 'production',
      runtimeVersion: '22.22.0',
      environment: {
        LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID: 'luczor-local-model-2026-01',
        LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64: invalidEncoding,
      },
    })
    assert.ok(rejected.errors.some(error => error.includes('manifest public key')))
  }

  const invalidBase64 = inspectProject({
    root: projectRoot,
    mode: 'production',
    runtimeVersion: '22.22.0',
    environment: {
      LUCZOR_LOCAL_MODEL_MANIFEST_KEY_ID: 'luczor-local-model-2026-01',
      LUCZOR_LOCAL_MODEL_MANIFEST_PUBLIC_KEY_B64: 'not-base64',
    },
  })
  assert.ok(invalidBase64.errors.some(error => error.includes('manifest public key')))
})

function expectErrors(errors) {
  assert.ok(errors.length > 0)
}
