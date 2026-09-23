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

export class ToolArgumentError extends Error {
  readonly code = 'tool_arguments_invalid'
  constructor(
    message: string,
    readonly field: string,
    readonly rule: string,
    readonly expected: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ToolArgumentError'
  }
}

/** Model-facing correction metadata never echoes the rejected value. */
export function toolArgumentFailure(error: unknown) {
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
    output: {
      code: 'tool_arguments_invalid',
      executed: false,
      ...(error instanceof ToolArgumentError
        ? { validation: { field: error.field, rule: error.rule, expected: error.expected } }
        : {}),
      guidance:
        'No tool was executed. Correct the reported field against the supplied schema before retrying. Paths are project-relative file identities; browser selectors are DOM targets. Do not interchange them or guess missing names. Repeating the same arguments cannot fix validation.',
    },
  }
}

export function validateToolArguments(schema: Record<string, unknown>, value: unknown): void {
  let visited = 0
  function check(rule: Record<string, unknown>, input: unknown, path: string, depth: number): void {
    const invalid = (message: string, constraint: string, expected: Record<string, unknown>, field = path): never => {
      throw new ToolArgumentError(message, field, constraint, expected)
    }
    if (depth > 12 || ++visited > 2000) throw new Error('Tool-Argumente sind zu tief oder zu umfangreich.')
    for (const key of Object.keys(rule))
      if (!supported.has(key)) throw new Error(`Nicht unterstütztes Tool-Schema: ${key}`)
    const type = rule.type
    if (Object.prototype.hasOwnProperty.call(rule, 'format') && (rule.format !== 'uuid' || type !== 'string'))
      throw new Error('Nicht unterstütztes Tool-Schema: format')
    if (type === 'object') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) invalid(`${path}: Objekt erwartet.`, 'type', { type })
      const record = input as Record<string, unknown>
      const properties = (rule.properties ?? {}) as Record<string, Record<string, unknown>>
      for (const key of (rule.required ?? []) as string[])
        if (!Object.prototype.hasOwnProperty.call(record, key))
          invalid(`${path}.${key}: Pflichtfeld fehlt.`, 'required', { required: true, type: properties[key]?.type }, `${path}.${key}`)
      for (const [key, item] of Object.entries(record)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${path}: Unerlaubter Feldname.`)
        if (Object.prototype.hasOwnProperty.call(properties, key))
          check(
            Object.getOwnPropertyDescriptor(properties, key)!.value as Record<string, unknown>,
            item,
            `${path}.${key}`,
            depth + 1
          )
        else if (rule.additionalProperties !== true)
          invalid(`${path}.${key}: Unbekanntes Feld.`, 'additionalProperties', { allowedFields: Object.keys(properties) }, `${path}.${key}`)
      }
    } else if (type === 'array') {
      if (!Array.isArray(input)) invalid(`${path}: Liste erwartet.`, 'type', { type })
      if (!Array.isArray(input)) return
      if (input.length > Number(rule.maxItems ?? 1000) || input.length < Number(rule.minItems ?? 0))
        invalid(`${path}: Ungültige Listenlänge.`, 'items', { minItems: rule.minItems ?? 0, maxItems: rule.maxItems ?? 1000 })
      for (const item of input) check((rule.items ?? {}) as Record<string, unknown>, item, `${path}[]`, depth + 1)
    } else if (type === 'string') {
      if (typeof input !== 'string') invalid(`${path}: Text erwartet.`, 'type', { type })
      if (typeof input !== 'string') return
      if (input.length > Number(rule.maxLength ?? 200_000) || input.length < Number(rule.minLength ?? 0))
        invalid(`${path}: Ungültige Textlänge.`, 'length', { minLength: rule.minLength ?? 0, maxLength: rule.maxLength ?? 200_000 })
      // Match the UUID string representation, also enforced by the server's
      // uuid rule. No coercion, URN prefixes, braces, or trailing line breaks.
      if (
        rule.format === 'uuid' &&
        (input.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input))
      )
        invalid(`${path}: UUID erwartet.`, 'format', { type, format: 'uuid' })
    } else if (type === 'number' || type === 'integer') {
      if (typeof input !== 'number' || !Number.isFinite(input) || (type === 'integer' && !Number.isInteger(input)))
        invalid(`${path}: ${type} erwartet.`, 'type', { type })
      if (typeof input !== 'number') return
      if (input < Number(rule.minimum ?? -Infinity) || input > Number(rule.maximum ?? Infinity))
        invalid(`${path}: Wert außerhalb des erlaubten Bereichs.`, 'range', { minimum: rule.minimum, maximum: rule.maximum })
    } else if (type === 'boolean' && typeof input !== 'boolean') invalid(`${path}: Boolean erwartet.`, 'type', { type })
    else if (type === 'null' && input !== null) invalid(`${path}: null erwartet.`, 'type', { type })
    else if (type !== undefined && !['boolean', 'null'].includes(String(type)))
      throw new Error(`${path}: Unbekannter Schematyp.`)
    if (Array.isArray(rule.enum) && !rule.enum.some(item => Object.is(item, input)))
      invalid(`${path}: Wert nicht erlaubt.`, 'enum', { enum: rule.enum })
  }
  check(schema, value, 'Argumente', 0)
}
