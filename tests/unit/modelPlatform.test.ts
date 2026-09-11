import { expect, it } from 'vitest'
import { modelPlatformTarget } from '@/services/inference/modelPlatform'

it.each(['windows', 'linux'])('selects the native %s catalog without browser user-agent guessing', platform => {
  expect(modelPlatformTarget({ platform, arch: 'x86_64' })).toBe(`${platform}-x86_64`)
})
it('does not silently assign a foreign architecture', () => {
  expect(() => modelPlatformTarget({ platform: 'windows', arch: 'aarch64' })).toThrow()
  expect(modelPlatformTarget({ platform: 'linux', arch: 'aarch64' })).toBe('linux-aarch64')
})
