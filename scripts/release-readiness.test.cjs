const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

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
