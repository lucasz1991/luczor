import { describe, expect, it } from 'vitest'
import { validateToolArguments } from '@/services/tools/validateArguments'
import { deviceTools } from '@/services/tools/devices'

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: { path: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, maximum: 3 } },
}
describe('tool argument admission', () => {
  it('rejects wrong types, extra keys, missing required values and invalid bounds', () => {
    for (const value of [
      [],
      null,
      { count: 1 },
      { path: '' },
      { path: 5 },
      { path: 'a', secret: 'x' },
      { path: 'a', count: 1.5 },
      { path: 'a', count: 4 },
    ]) {
      expect(() => validateToolArguments(schema, value)).toThrow()
    }
    expect(() => validateToolArguments(schema, { path: 'src/main.ts', count: 2 })).not.toThrow()
  })
  it('rejects prototype keys and unsupported schema features instead of ignoring them', () => {
    expect(() =>
      validateToolArguments({ type: 'object', additionalProperties: true }, JSON.parse('{"__proto__": {}}'))
    ).toThrow()
    expect(() => validateToolArguments({ type: 'string', pattern: 'abc' }, 'def')).toThrow('Schema')
  })

  it('admits the real device_dispatch contract with canonical UUID operation identifiers', () => {
    const dispatch = deviceTools.find(tool => tool.name === 'device_dispatch')!
    for (const operation_id of [
      '550e8400-e29b-41d4-a716-446655440000',
      '550E8400-E29B-41D4-A716-446655440000',
      '019a0011-2233-7444-8555-66778899aabb',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      const args = { target_device_id: 'linux-device', tool_profile: 'desktop.observe', payload: {}, operation_id }
      expect(() => validateToolArguments(dispatch.parameters, args)).not.toThrow()
      expect(args.operation_id).toBe(operation_id)
    }
  })

  it('rejects malformed device operation IDs before dispatch without accepting arbitrary formats', () => {
    const dispatch = deviceTools.find(tool => tool.name === 'device_dispatch')!
    for (const operation_id of [
      'not-a-uuid',
      '550e8400e29b41d4a716446655440000',
      '550e8400-e29b-41d4-a716-44665544000g',
      '550e8400-e29b-41d4-a716-446655440000\n',
      ' 550e8400-e29b-41d4-a716-446655440000',
      '{550e8400-e29b-41d4-a716-446655440000}',
      'urn:uuid:550e8400-e29b-41d4-a716-446655440000',
    ]) {
      expect(() =>
        validateToolArguments(dispatch.parameters, {
          target_device_id: 'linux-device',
          tool_profile: 'desktop.observe',
          payload: {},
          operation_id,
        })
      ).toThrow('UUID')
    }
    expect(() => validateToolArguments({ type: 'string', format: 'email' }, 'user@example.test')).toThrow('Schema')
    expect(() => validateToolArguments({ type: 'string', format: null }, 'value')).toThrow('Schema')
    expect(() => validateToolArguments({ type: 'number', format: 'uuid' }, 123)).toThrow('Schema')
  })
})
