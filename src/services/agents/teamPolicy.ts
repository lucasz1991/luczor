export const SPECIALIST_ROLES = ['planning', 'research', 'coding', 'review'] as const
export type SpecialistRole = (typeof SPECIALIST_ROLES)[number]
export const SPECIALIST_LABELS: Record<SpecialistRole, string> = {
  planning: 'Planung',
  research: 'Recherche',
  coding: 'Codeentwurf',
  review: 'Prüfung',
}
export type TeamPresetChoice = 'server' | 'local' | 'free' | 'budget'
export function roleValue<T>(record: Record<SpecialistRole, T>, role: SpecialistRole): T {
  // The closed role union is validated at the policy boundary and never contains arbitrary property names.
  // eslint-disable-next-line security/detect-object-injection
  return record[role]
}
export type TeamPolicy = {
  version: 1
  revision: string
  enabled: boolean
  default_preset: 'free' | 'budget'
  presets: Array<{
    id: 'free' | 'budget'
    label: string
    description: string
    max_parallel: number
    roles: Record<SpecialistRole, { target: 'local' | 'external'; task_type: string }>
  }>
  models_by_role: Record<
    SpecialistRole,
    {
      ready: boolean
      reason_code?: string | null
      max_cost_usd?: number
      max_output_tokens?: number
      max_attempts?: number
      candidates: Array<{
        id: string
        name: string
        provider: string
        input_per_million: number | null
        output_per_million: number | null
        data_policy: string
      }>
    }
  >
}

const READINESS_REASONS = new Map<string, string>([
  ['agent_team_not_configured', 'Teamkonfiguration fehlt'],
  ['agent_team_disabled', 'externe Teams sind deaktiviert'],
  ['agent_role_disabled', 'Rollenroute ist deaktiviert'],
  ['routing_use_case_unavailable', 'Modellroute fehlt'],
  ['routing_no_candidates', 'keine aktiven Rollenmodelle'],
  ['routing_credential_incompatible', 'kompatibler aktiver Provider-Zugang fehlt'],
  ['routing_price_unavailable', 'gültige Modellpreise fehlen'],
  ['routing_network_policy_unavailable', 'Netzwerkrichtlinie fehlt oder ist deaktiviert'],
  ['routing_network_policy_retry_statuses_invalid', 'Netzwerkrichtlinie ist ungültig'],
  ['routing_budget_exceeded', 'Kosten- oder Tokenlimit reicht nicht aus'],
  ['routing_budget_policy_invalid', 'Kosten- oder Tokenlimit ist ungültig'],
  ['routing_capability_unavailable', 'benötigter Chat-Vertrag wird nicht unterstützt'],
  ['routing_context_window_exceeded', 'Ausgabelimit überschreitet das Modellkontextfenster'],
])

/** Render only client-owned explanations, never arbitrary server prose in an agent handoff. */
export function specialistReadinessMessage(policy: TeamPolicy, role: SpecialistRole): string {
  const models = roleValue(policy.models_by_role, role)
  const reason = READINESS_REASONS.get(models.reason_code ?? '') ?? 'kein ausführbares Rollenmodell'
  return `${roleValue(SPECIALIST_LABELS, role)}: ${reason}`
}

/** Reject unknown routes; a server profile never supplies a client-side model override. */
export function parseTeamPolicy(value: unknown): TeamPolicy {
  const policy = value as TeamPolicy
  if (
    !policy ||
    policy.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(policy.revision ?? '') ||
    typeof policy.enabled !== 'boolean' ||
    !['free', 'budget'].includes(policy.default_preset) ||
    !Array.isArray(policy.presets)
  )
    throw new Error('Ungültige Agententeam-Richtlinie.')
  for (const preset of policy.presets) {
    if (
      !['free', 'budget'].includes(preset.id) ||
      !Number.isInteger(preset.max_parallel) ||
      preset.max_parallel < 1 ||
      preset.max_parallel > 3
    )
      throw new Error('Ungültiges Agententeam-Profil.')
    for (const role of SPECIALIST_ROLES) {
      const entry = preset.roles && roleValue(preset.roles, role)
      if (
        !entry ||
        entry.task_type !== `agent.${role}` ||
        !['local', 'external'].includes(entry.target) ||
        (role !== 'planning' && entry.target !== 'external') ||
        (preset.id === 'free' && role === 'planning' && entry.target !== 'local')
      )
        throw new Error('Ungültige Agentenrolle.')
      if (!policy.models_by_role || !Array.isArray(roleValue(policy.models_by_role, role)?.candidates))
        throw new Error('Agentenmodell-Kandidaten fehlen.')
    }
  }
  return structuredClone(policy)
}
