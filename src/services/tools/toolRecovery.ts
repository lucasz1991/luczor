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
  if (
    name === 'fs_read' &&
    /Project path does not exist|Project read path must be a regular file|file_reference_|path is empty/u.test(error)
  ) {
    return {
      code: 'file_selection_required',
      guidance:
        'The file target was invalid or unavailable. This does not prove fs_read is broken. Do not guess spelling or dates. Use fs_list, select an entry with kind=file, then call fs_read with its exact file_ref and omit path. Use fs_list for directories. Error counts describe attempted inputs, not general tool availability.',
      next_tool: 'fs_list',
      next_arguments: { path: '.', max_depth: 2 },
    }
  }
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
  private fileSelectionFailures = 0
  private observedFiles = new Map<string, { path: string; file_ref?: string }>()

  canOffer(name: string): boolean {
    if (name === 'browser_status') return true
    if (name === 'browser_close') return this.closeFailures < 3
    return !name.startsWith('browser_') || this.browserFailures < 3
  }

  blocked(name: string, args: Record<string, unknown>): Outcome | undefined {
    if (name === 'fs_read' && this.fileSelectionFailures >= 2) {
      const observed = [...this.observedFiles.values()].some(file =>
        args.file_ref !== undefined
          ? args.file_ref === file.file_ref && (args.path === undefined || args.path === file.path)
          : args.path === file.path
      )
      if (!observed)
        return {
          ok: false,
          error:
            'File selection paused after repeated invalid targets. Run fs_list and use a returned file_ref; do not invent another filename.',
          output: {
            code: 'file_selection_required',
            next_tool: 'fs_list',
            next_arguments: { path: '.', max_depth: 2 },
            observed_files: [...this.observedFiles.values()].slice(-8),
          },
        }
    }
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
      if (['fs_list', 'fs_search', 'fs_stat', 'fs_read'].includes(name)) {
        const result = details(outcome.output)
        const entries = name === 'fs_list' ? result?.entries : name === 'fs_search' ? result?.matches : [result]
        if (Array.isArray(entries))
          for (const value of entries) {
            const entry = details(value)
            if (!entry || typeof entry.path !== 'string' || (entry.kind !== undefined && entry.kind !== 'file'))
              continue
            this.observedFiles.delete(entry.path)
            this.observedFiles.set(entry.path, {
              path: entry.path,
              ...(typeof entry.file_ref === 'string' ? { file_ref: entry.file_ref } : {}),
            })
            while (this.observedFiles.size > 512) this.observedFiles.delete(this.observedFiles.keys().next().value!)
          }
        if (name === 'fs_read') this.fileSelectionFailures = 0
      }
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
    if (next.code === 'file_selection_required') {
      this.fileSelectionFailures++
      for (const [path, file] of this.observedFiles)
        if (args.path === path || (typeof args.file_ref === 'string' && args.file_ref === file.file_ref))
          this.observedFiles.delete(path)
    }
    if (name === 'browser_close') this.closeFailures++
    else if (name.startsWith('browser_') && name !== 'browser_status') this.browserFailures++
    if (next.code === 'workflow_vision_multimodal_runtime_unavailable' && args.inference !== 'external')
      this.localVisionUnavailable = true
    return {
      ...outcome,
      output: {
        ...(details(outcome.output) ?? {}),
        recovery: next,
        ...(next.code === 'file_selection_required'
          ? { observed_files: [...this.observedFiles.values()].slice(-8) }
          : {}),
        ...(this.blocked(name, args)?.output as object | undefined),
      },
    }
  }
}
