const failureCodes = [
  'runtime_context_exceeded',
  'runtime_chat_history_rejected',
  'runtime_chat_template_failed',
  'runtime_tool_contract_rejected',
  'runtime_capacity_exhausted',
  'runtime_auth_failed',
  'runtime_model_unavailable',
  'runtime_request_rejected',
  'runtime_server_failed',
  'runtime_http_failed',
  'runtime_reasoning_control_unavailable',
  'runtime_stream_failed',
  'runtime_start_failed',
] as const

const stages = ['preparation', 'tokenization', 'generation', 'unknown'] as const
const reasons = [
  'context_limit',
  'message_order',
  'message_shape',
  'tool_contract',
  'template',
  'parameter_type',
  'parameter_value',
  'unsupported_parameter',
  'capacity',
  'authentication',
  'model_unavailable',
  'server',
  'unclassified',
] as const
const parameters = [
  'model',
  'messages',
  'messages.role',
  'messages.content',
  'tools',
  'tool_choice',
  'max_tokens',
  'n_predict',
  'reasoning_budget_tokens',
  'thinking_budget_tokens',
  'reasoning_control',
  'reasoning_effort',
  'chat_template_kwargs',
  'enable_thinking',
  'parse_tool_calls',
  'stream',
  'stream_options',
  'cache_prompt',
  'timings_per_token',
  'temperature',
  'top_p',
  'response_format',
  'grammar',
  'seed',
] as const

export type LocalFailureCode = (typeof failureCodes)[number]
export type LocalFailureParameter = (typeof parameters)[number]
export type LocalFailureDiagnostic = {
  schemaVersion: 1
  stage: (typeof stages)[number]
  httpStatus?: number
  code: LocalFailureCode
  parameter?: LocalFailureParameter
  reason: (typeof reasons)[number]
  inputTokens?: number
  contextTokens?: number
  outputTokens?: number
}

function includesValue<const Values extends readonly string[]>(
  values: Values,
  value: unknown
): value is Values[number] {
  return typeof value === 'string' && values.includes(value)
}

/** Project native IPC data; raw errors, prompts, endpoints and parameter values never cross this boundary. */
export function readLocalFailureDiagnostic(value: unknown): LocalFailureDiagnostic | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (
    source.schemaVersion !== 1 ||
    !includesValue(stages, source.stage) ||
    !includesValue(failureCodes, source.code) ||
    !includesValue(reasons, source.reason)
  )
    return null
  const diagnostic: LocalFailureDiagnostic = {
    schemaVersion: 1,
    stage: source.stage,
    code: source.code,
    reason: source.reason,
  }
  if (includesValue(parameters, source.parameter)) diagnostic.parameter = source.parameter
  if (
    typeof source.httpStatus === 'number' &&
    Number.isInteger(source.httpStatus) &&
    source.httpStatus >= 100 &&
    source.httpStatus <= 599
  ) {
    diagnostic.httpStatus = source.httpStatus
  }
  for (const field of ['inputTokens', 'contextTokens', 'outputTokens'] as const) {
    const count = source[field]
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) diagnostic[field] = count
  }
  return diagnostic
}

const stageLabels: Record<LocalFailureDiagnostic['stage'], string> = {
  preparation: 'Modellvorbereitung',
  tokenization: 'Tokenzählung und Kontextprüfung',
  generation: 'Antwortgenerierung',
  unknown: 'Fehlerstufe nicht gemeldet',
}
const reasonDescriptions: Record<LocalFailureDiagnostic['reason'], string> = {
  context_limit:
    'Der Auftrag überschreitet das verfügbare Kontextfenster. Kontextumfang und Antwortreserve prüfen; große Inhalte abschnittsweise bearbeiten.',
  message_order:
    'Die Nachrichtenreihenfolge passt nicht zur Modellvorlage. Rollen und zugehörige Werkzeugantworten im Chatverlauf prüfen.',
  message_shape: 'Das Nachrichtenformat ist ungültig. Rollen und Inhaltstypen der Modellanfrage prüfen.',
  tool_contract:
    'Das Modell konnte die Werkzeugdaten nicht verarbeiten. Werkzeugschema, Argumente und Zuordnung der Werkzeugantworten prüfen.',
  template:
    'Die Chatvorlage konnte nicht angewendet werden. Die Modellvorlage auf Kompatibilität mit Nachrichten und Werkzeugen prüfen.',
  parameter_type:
    'Ein Anfrageparameter hat einen ungültigen Datentyp. Den erwarteten Typ in der Runtime-Schnittstelle prüfen.',
  parameter_value: 'Ein Anfrageparameter hat einen ungültigen Wert. Den erlaubten Wertebereich der Runtime prüfen.',
  unsupported_parameter:
    'Die Runtime unterstützt einen Anfrageparameter nicht. Parametervertrag und Runtime-Version prüfen.',
  capacity:
    'Die Runtime hat nicht genügend freie Kapazität. Freien RAM und Grafikspeicher sowie Kontext- und Modellbelegung prüfen.',
  authentication: 'Die lokale Runtime hat die Anmeldung abgewiesen. Die native Verbindungskonfiguration prüfen.',
  model_unavailable:
    'Die Runtime konnte das angefragte Modell nicht bereitstellen. Modellzuordnung und lokalen Installationsstatus prüfen.',
  server:
    'Die lokale Runtime meldet einen internen Fehler. Runtime-Status und Version prüfen; anschließend erneut versuchen.',
  unclassified: 'Die lokale Modellanfrage ist fehlgeschlagen. Die gemeldete Fehlerstufe und den Runtime-Status prüfen.',
}
const codeDescriptions: Partial<Record<LocalFailureCode, string>> = {
  runtime_reasoning_control_unavailable:
    'Die Runtime hat den Abschluss der Denkphase nicht bestätigt. Denkbudget und Runtime-Unterstützung prüfen. Das Modell bleibt geladen.',
  runtime_stream_failed:
    'Die lokale Modellverbindung wurde während der Anfrage unterbrochen. Den Runtime-Status prüfen und die Anfrage erneut versuchen.',
  runtime_start_failed:
    'Das lokale Modell konnte nicht vorbereitet werden. Installationsstatus, Ressourcen und Runtime-Status prüfen.',
}

/** Public text is composed solely from the fixed diagnostic vocabulary and validated counters. */
export function describeLocalFailureDiagnostic(value: LocalFailureDiagnostic): string {
  const diagnostic = readLocalFailureDiagnostic(value)
  if (!diagnostic) return 'Für die lokale Modellanfrage liegt keine gültige Fehlerdiagnose vor.'
  const details: string[] = [stageLabels[diagnostic.stage]]
  if (diagnostic.httpStatus !== undefined) details.push(`HTTP ${diagnostic.httpStatus}`)
  if (diagnostic.parameter) details.push(`Parameter: ${diagnostic.parameter}`)
  const description =
    diagnostic.reason === 'unclassified'
      ? (codeDescriptions[diagnostic.code] ?? reasonDescriptions.unclassified)
      : reasonDescriptions[diagnostic.reason]
  const counts: string[] = []
  if (diagnostic.inputTokens !== undefined)
    counts.push(`Eingabe (gezählt) ${diagnostic.inputTokens.toLocaleString('de-DE')}`)
  if (diagnostic.contextTokens !== undefined) counts.push(`Kontext ${diagnostic.contextTokens.toLocaleString('de-DE')}`)
  if (diagnostic.outputTokens !== undefined)
    counts.push(`Ausgabelimit ${diagnostic.outputTokens.toLocaleString('de-DE')}`)
  return `${details.join(' · ')}: ${description}${counts.length ? ` Tokenbudget: ${counts.join(' · ')}.` : ''}`
}
