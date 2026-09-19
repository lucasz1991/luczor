import { describe, expect, it } from 'vitest'
import {
  describeLocalFailureDiagnostic,
  readLocalFailureDiagnostic,
  type LocalFailureDiagnostic,
} from '@/services/inference/localFailure'

const diagnostic: LocalFailureDiagnostic = {
  schemaVersion: 1,
  stage: 'tokenization',
  code: 'runtime_request_rejected',
  reason: 'unsupported_parameter',
  parameter: 'reasoning_effort',
  httpStatus: 400,
}

describe('public local inference failure diagnostics', () => {
  it('projects only known metadata and measured counters, never raw errors or parameter values', () => {
    const decoded = readLocalFailureDiagnostic({
      ...diagnostic,
      inputTokens: 0,
      contextTokens: 18000,
      outputTokens: 2048,
      rawError: 'PRIVATE prompt',
      endpoint: 'http://localhost/secret',
      credentials: 'PRIVATE bearer',
      parameterValue: 'PRIVATE value',
      messages: [{ content: 'PRIVATE message' }],
    })
    expect(decoded).toEqual({ ...diagnostic, inputTokens: 0, contextTokens: 18000, outputTokens: 2048 })
    expect(JSON.stringify(decoded)).not.toContain('PRIVATE')
    expect(describeLocalFailureDiagnostic(decoded!)).toContain(
      'Tokenzählung und Kontextprüfung · HTTP 400 · Parameter: reasoning_effort'
    )
    expect(describeLocalFailureDiagnostic(decoded!)).toContain('Ausgabelimit 2.048')
    expect(describeLocalFailureDiagnostic(decoded!)).not.toContain('localhost')
  })

  it.each([
    null,
    [],
    'PRIVATE',
    {},
    { ...diagnostic, schemaVersion: 2 },
    { ...diagnostic, stage: 'PRIVATE' },
    { ...diagnostic, reason: 'PRIVATE' },
    { ...diagnostic, code: 'PRIVATE' },
    { ...diagnostic, code: 'runtime_transport_interrupted' },
  ])('rejects unknown required contract fields (%j)', value => {
    expect(readLocalFailureDiagnostic(value)).toBeNull()
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '2048', null])(
    'drops invalid token counters without replacing them with estimates (%s)',
    value => {
      const decoded = readLocalFailureDiagnostic({
        ...diagnostic,
        inputTokens: value,
        contextTokens: value,
        outputTokens: value,
      })
      expect(decoded).toEqual(diagnostic)
      expect(describeLocalFailureDiagnostic(decoded!)).not.toContain('Tokenbudget')
    }
  )

  it.each([99, 600, 400.5, '400', Number.NaN])('drops invalid HTTP statuses (%s)', httpStatus => {
    const decoded = readLocalFailureDiagnostic({ ...diagnostic, httpStatus })
    expect(decoded?.httpStatus).toBeUndefined()
    expect(describeLocalFailureDiagnostic(decoded!)).not.toContain('HTTP')
  })

  it('drops arbitrary parameter paths and remains defensive when describing an unchecked value', () => {
    const decoded = readLocalFailureDiagnostic({ ...diagnostic, parameter: 'messages[0].content.PRIVATE' })
    expect(decoded?.parameter).toBeUndefined()
    expect(describeLocalFailureDiagnostic(decoded!)).not.toContain('PRIVATE')
    expect(
      describeLocalFailureDiagnostic({ ...diagnostic, reason: 'PRIVATE' } as unknown as LocalFailureDiagnostic)
    ).toBe('Für die lokale Modellanfrage liegt keine gültige Fehlerdiagnose vor.')
  })

  it.each(['preparation', 'tokenization', 'generation', 'unknown'] as const)(
    'preserves the reported stage %s without inferring native token counts',
    stage => {
      const decoded = readLocalFailureDiagnostic({ ...diagnostic, stage })!
      expect(decoded.stage).toBe(stage)
      expect(decoded.inputTokens).toBeUndefined()
      expect(describeLocalFailureDiagnostic(decoded)).not.toContain('Tokenbudget')
    }
  )

  it('labels an unknown stage as not reported', () => {
    expect(describeLocalFailureDiagnostic({ ...diagnostic, stage: 'unknown' })).toContain('nicht gemeldet')
  })

  it('recognizes preparation failures and gives an actionable non-secret hint', () => {
    const decoded = readLocalFailureDiagnostic({
      schemaVersion: 1,
      stage: 'preparation',
      code: 'runtime_start_failed',
      reason: 'unclassified',
    })!
    expect(decoded.code).toBe('runtime_start_failed')
    expect(describeLocalFailureDiagnostic(decoded)).toContain(
      'Installationsstatus, Ressourcen und Runtime-Status prüfen'
    )
  })

  it.each([
    ['runtime_first_progress_timeout', 'Startfrist'],
    ['runtime_progress_timeout', 'danach aber zu lange'],
    ['runtime_total_timeout', 'festes Zeitbudget'],
  ] as const)('distinguishes the bounded generation failure %s from a connection failure', (code, hint) => {
    const decoded = readLocalFailureDiagnostic({
      schemaVersion: 1,
      stage: 'generation',
      code,
      reason: 'unclassified',
      inputTokens: 490,
      contextTokens: 8192,
      outputTokens: 768,
      rawError: 'PRIVATE',
    })!
    expect(decoded.code).toBe(code)
    const description = describeLocalFailureDiagnostic(decoded)
    expect(description).toContain(hint)
    expect(description).toContain('Eingabe (gezählt) 490')
    expect(description).not.toContain('PRIVATE')
    expect(description).not.toContain('Modellverbindung wurde')
  })
})
