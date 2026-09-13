type Outcome = { ok: boolean; error?: string; output?: unknown }
type Recovery = { code: string; guidance: string; next_tool?: string; next_arguments?: Record<string, unknown> }

function details(output: unknown): Record<string, unknown> | undefined {
  return output && typeof output === 'object' && !Array.isArray(output)
    ? (output as Record<string, unknown>)
    : undefined
}

function recovery(name: string, outcome: Outcome): Recovery | undefined {
  const output = details(outcome.output)
  const error = `${outcome.error ?? ''} ${typeof output?.code === 'string' ? output.code : ''}`
  if (name.startsWith('browser_')) {
    const code =
      error.match(/\b(?:workflow_browser_[a-z_]+|browser_session_hosts_changed)\b/u)?.[0] ?? 'browser_action_failed'
    return {
      code,
      guidance:
        code === 'workflow_browser_owned_by_another_run'
          ? 'Ein anderer Auftrag hält den Browser. Andere Arbeit fortsetzen; keine Hosts raten und die fremde Sitzung nicht übernehmen.'
          : 'Die eigene Bindung mit browser_status {} prüfen. Bei einer falschen Bindung browser_close {} und erst danach gezielt browser_open verwenden. Keine Hostvarianten durchprobieren.',
      next_tool: 'browser_status',
      next_arguments: {},
    }
  }
  if (name === 'image_analyze' && error.includes('workflow_vision_multimodal_runtime_unavailable')) {
    return {
      code: 'workflow_vision_multimodal_runtime_unavailable',
      guidance:
        'Diese Runtime hat keine lokale Vision-Fähigkeit. capabilities prüfen; OCR ist nur Texterkennung. Keine automatische externe Übertragung.',
      next_tool: 'image_analyze',
      next_arguments: { action: 'capabilities' },
    }
  }
  if (name.startsWith('os_') && /Desktop observation|Desktop focus|visible foreground window/u.test(error)) {
    return {
      code: 'desktop_observation_required',
      guidance:
        'Es wurde keine Eingabe gesendet. Das gewünschte sichtbare Fenster muss fokussiert sein. Dann os_observe_desktop erneut ausführen und die neue observation_id genau einmal sofort für die Eingabe verwenden. Alte IDs nicht wiederholen.',
      next_tool: 'os_observe_desktop',
      next_arguments: {},
    }
  }
  return undefined
}

/** Per-run recovery budget. Argument guessing does not reset a failing browser path. */
export class ToolRecoveryGuard {
  private browserFailures = 0
  private closeFailures = 0
  private localVisionUnavailable = false

  canOffer(name: string): boolean {
    if (name === 'browser_status') return true
    if (name === 'browser_close') return this.closeFailures < 3
    return !name.startsWith('browser_') || this.browserFailures < 3
  }

  blocked(name: string, args: Record<string, unknown>): Outcome | undefined {
    const vision =
      name === 'image_analyze' &&
      args.action === 'vision' &&
      args.inference !== 'external' &&
      this.localVisionUnavailable
    if (!vision && this.canOffer(name)) return undefined
    return {
      ok: false,
      error: vision
        ? 'Lokale Bildanalyse ist für diese Runtime bereits als nicht verfügbar bestätigt. capabilities oder OCR verwenden; andere Arbeit kann weiterlaufen.'
        : 'Dieser Browserweg ist nach drei fehlgeschlagenen Versuchen für den Auftrag pausiert. Keine weiteren Hostvarianten versuchen. Andere Werkzeuge bleiben nutzbar.',
      output: {
        code: 'tool_recovery_required',
        blocked_tool: name,
        next_tool: vision ? 'image_analyze' : 'browser_status',
        next_arguments: vision ? { action: 'capabilities' } : {},
        guidance:
          'Zuerst die Ursache anhand des Status beheben. Eine erfolgreich geschlossene eigene Sitzung gibt den Browserweg wieder frei.',
      },
    }
  }

  record(name: string, args: Record<string, unknown>, outcome: Outcome): Outcome {
    if (outcome.ok) {
      if (name === 'browser_close' && details(outcome.output)?.closed === true) {
        this.browserFailures = 0
        this.closeFailures = 0
      } else if (name.startsWith('browser_') && !['browser_status', 'browser_close'].includes(name)) {
        this.browserFailures = 0
      }
      return outcome
    }
    const next = recovery(name, outcome)
    if (!next) return outcome
    if (name === 'browser_close') this.closeFailures++
    else if (name.startsWith('browser_') && name !== 'browser_status') this.browserFailures++
    if (next.code === 'workflow_vision_multimodal_runtime_unavailable' && args.inference !== 'external')
      this.localVisionUnavailable = true
    return {
      ...outcome,
      output: {
        ...(details(outcome.output) ?? {}),
        recovery: next,
        ...(this.blocked(name, args)?.output as object | undefined),
      },
    }
  }
}
