import { describe, expect, it } from 'vitest'
import { validateToolArguments } from '@/services/tools/validateArguments'

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
})
