/** The registry's deliberately small JSON-Schema subset. Unknown schema keywords fail closed. */
const supported = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'format',
  'description',
  'default',
  'title',
])

export function validateToolArguments(schema: Record<string, unknown>, value: unknown): void {
  let visited = 0
  function check(rule: Record<string, unknown>, input: unknown, path: string, depth: number): void {
    if (depth > 12 || ++visited > 2000) throw new Error('Tool-Argumente sind zu tief oder zu umfangreich.')
    for (const key of Object.keys(rule))
      if (!supported.has(key)) throw new Error(`Nicht unterstütztes Tool-Schema: ${key}`)
    const type = rule.type
    if (Object.prototype.hasOwnProperty.call(rule, 'format') && (rule.format !== 'uuid' || type !== 'string'))
      throw new Error('Nicht unterstütztes Tool-Schema: format')
    if (type === 'object') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${path}: Objekt erwartet.`)
      const record = input as Record<string, unknown>
      const properties = (rule.properties ?? {}) as Record<string, Record<string, unknown>>
      for (const key of (rule.required ?? []) as string[])
        if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`${path}.${key}: Pflichtfeld fehlt.`)
      for (const [key, item] of Object.entries(record)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${path}: Unerlaubter Feldname.`)
        if (Object.prototype.hasOwnProperty.call(properties, key))
          check(
            Object.getOwnPropertyDescriptor(properties, key)!.value as Record<string, unknown>,
            item,
            `${path}.${key}`,
            depth + 1
          )
        else if (rule.additionalProperties !== true) throw new Error(`${path}.${key}: Unbekanntes Feld.`)
      }
    } else if (type === 'array') {
      if (!Array.isArray(input)) throw new Error(`${path}: Liste erwartet.`)
      if (input.length > Number(rule.maxItems ?? 1000) || input.length < Number(rule.minItems ?? 0))
        throw new Error(`${path}: Ungültige Listenlänge.`)
      for (const item of input) check((rule.items ?? {}) as Record<string, unknown>, item, `${path}[]`, depth + 1)
    } else if (type === 'string') {
      if (typeof input !== 'string') throw new Error(`${path}: Text erwartet.`)
      if (input.length > Number(rule.maxLength ?? 200_000) || input.length < Number(rule.minLength ?? 0))
        throw new Error(`${path}: Ungültige Textlänge.`)
      // Match the UUID string representation, also enforced by the server's
      // uuid rule. No coercion, URN prefixes, braces, or trailing line breaks.
      if (
        rule.format === 'uuid' &&
        (input.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input))
      )
        throw new Error(`${path}: UUID erwartet.`)
    } else if (type === 'number' || type === 'integer') {
      if (typeof input !== 'number' || !Number.isFinite(input) || (type === 'integer' && !Number.isInteger(input)))
        throw new Error(`${path}: ${type} erwartet.`)
      if (input < Number(rule.minimum ?? -Infinity) || input > Number(rule.maximum ?? Infinity))
        throw new Error(`${path}: Wert außerhalb des erlaubten Bereichs.`)
    } else if (type === 'boolean' && typeof input !== 'boolean') throw new Error(`${path}: Boolean erwartet.`)
    else if (type === 'null' && input !== null) throw new Error(`${path}: null erwartet.`)
    else if (type !== undefined && !['boolean', 'null'].includes(String(type)))
      throw new Error(`${path}: Unbekannter Schematyp.`)
    if (Array.isArray(rule.enum) && !rule.enum.some(item => Object.is(item, input)))
      throw new Error(`${path}: Wert nicht erlaubt.`)
  }
  check(schema, value, 'Argumente', 0)
}
