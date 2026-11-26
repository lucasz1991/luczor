/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS release-script tests. */
const assert = require('node:assert/strict')
const test = require('node:test')
const { checkReleaseVersion } = require('./check-release-version.cjs')

const commits = new Map([
  ['v2.9.0', 'aaa'],
  ['v2.9.3', 'bbb'],
  ['v2.10.0', 'ccc'],
])
const input = changes => ({
  version: '2.9.4',
  tags: ['v2.9.0', 'v2.9.3', 'unrelated', 'v2.0.2'],
  head: 'zzz',
  commitOf: tag => commits.get(tag),
  ...changes,
})

test('accepts a version above the highest delivered tag', () => {
  assert.deepEqual(checkReleaseVersion(input()), { version: '2.9.4', latestTag: 'v2.9.3', rebuild: false })
})

test('compares numerically rather than as text', () => {
  assert.throws(() => checkReleaseVersion(input({ tags: ['v2.9.3', 'v2.10.0'] })), /not above the delivered v2\.10\.0/u)
  assert.equal(checkReleaseVersion(input({ version: '2.10.1', tags: ['v2.9.3', 'v2.10.0'] })).latestTag, 'v2.10.0')
})

test('rejects an unchanged version on a commit after the delivered tag', () => {
  assert.throws(() => checkReleaseVersion(input({ version: '2.9.3' })), /pnpm bump/u)
  assert.throws(() => checkReleaseVersion(input({ version: '2.9.2' })), /not above/u)
})

test('permits rebuilding exactly the tagged commit', () => {
  assert.equal(checkReleaseVersion(input({ version: '2.9.3', head: 'bbb' })).rebuild, true)
})

test('passes without delivered tags and rejects versions the package manager cannot order', () => {
  assert.equal(checkReleaseVersion(input({ tags: ['unrelated'] })).latestTag, null)
  assert.throws(() => checkReleaseVersion(input({ version: '2.9.4-beta.1' })), /plain MAJOR/u)
})
