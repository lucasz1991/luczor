import { compactToolOutput } from '@/services/inference/contextBudget'

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
  if (output?.code === 'tool_arguments_invalid')
    return {
      code: 'tool_arguments_invalid',
      guidance:
        'No action ran. Use validation.field and validation.expected to correct the arguments. Do not retry unchanged input.',
    }
  if (name.startsWith('fs_') && /path must be relative|path must not contain|path is invalid/u.test(error))
    return {
      code: 'project_relative_path_required',
      guidance:
        'No action ran. The path must be relative to the bound project, never an absolute path, parent traversal, CSS selector or @project alias. List the project root and copy the returned identity. Do not guess or silently rewrite a write target.',
      next_tool: 'fs_list',
      next_arguments: { path: '.', max_depth: 1 },
    }
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
    const code = error.match(/\b(?:workflow_browser_[a-z_]+|browser_[a-z_]+)\b/u)?.[0] ?? 'browser_action_failed'
    const targetError = /browser_(ref_stale|target_|selector_|page_not_ready)/u.test(code)
    return {
      code,
      guidance: targetError
        ? 'No action was confirmed. Scan the DOM again and use the exact observed ref. Do not guess selectors or retry uncertain writes. Use screenshot and image_analyze only for an explicit visual exception.'
        : code === 'workflow_browser_owned_by_another_run'
          ? 'Ein anderer Auftrag hält den Browser. Andere Arbeit fortsetzen; keine Hosts raten und die fremde Sitzung nicht übernehmen.'
          : 'Die eigene Bindung mit browser_status {} prüfen. Bei einer falschen Bindung browser_close {} und erst danach gezielt browser_open verwenden. Keine Hostvarianten durchprobieren.',
      next_tool: targetError ? 'browser_dom_scan' : 'browser_status',
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

const repeatedReads = new Set([
  'fs_list',
  'fs_search',
  'project_get_state',
  'workspace_get',
  'context_read_history',
  'repository_search',
])
function stableData(value: unknown): string {
  return (
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
        : item
    ) ?? 'null'
  )
}

/** Per-run recovery budget. Argument guessing does not reset a failing browser path. */
export class ToolRecoveryGuard {
  private browserFailures = 0
  private closeFailures = 0
  private localVisionUnavailable = false
  private fileSelectionFailures = 0
  private observedFiles = new Map<string, { path: string; file_ref?: string }>()
  // Only bounded, exact observations. Polling jobs/browser state is deliberately excluded.
  private reads = new Map<string, { signature: string; count: number; output: unknown }>()

  private repeatedRead(name: string, args: Record<string, unknown>): Outcome | undefined {
    const previous = this.reads.get(stableData([name, args]))
    if (!previous || previous.count < 3) return undefined
    const file = [...this.observedFiles.values()].at(-1)
    return {
      ok: false,
      error: 'Repeated identical read without new evidence. Reuse the previous result and take the next concrete step.',
      output: {
        code: 'tool_read_loop',
        executed: false,
        repetitions: previous.count,
        previous_observation: previous.output,
        guidance:
          'This is an earlier observation, not a fresh check. Read a selected file or graph result, read an archive index instead of searching again, or report the actual blocker. Unchanged reads do not advance the task.',
        ...(name === 'fs_list' && file
          ? { next_tool: 'fs_read', next_arguments: file.file_ref ? { file_ref: file.file_ref } : { path: file.path } }
          : {}),
      },
    }
  }

  canOffer(name: string): boolean {
    if (name === 'browser_status' || name === 'browser_dom_scan') return true
    if (name === 'browser_close') return this.closeFailures < 3
    return !name.startsWith('browser_') || this.browserFailures < 3
  }

  blocked(name: string, args: Record<string, unknown>): Outcome | undefined {
    const repeated = this.repeatedRead(name, args)
    if (repeated) return repeated
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

  record(name: string, args: Record<string, unknown>, outcome: Outcome, mutating = false): Outcome {
    if (outcome.ok) {
      if (mutating || name === 'fs_read') this.reads.clear()
      if (repeatedReads.has(name)) {
        const key = stableData([name, args])
        const signature = stableData(outcome.output)
        // Large responses remain governed by context budgeting; never retain an
        // unbounded duplicate or compare only a prefix and call it identical.
        if (signature.length <= 100_000 && key.length <= 4000) {
          const previous = this.reads.get(key)
          const count = previous?.signature === signature ? previous.count + 1 : 1
          this.reads.delete(key)
          this.reads.set(key, { signature, count, output: compactToolOutput(outcome.output, 1600) })
          while (this.reads.size > 24) this.reads.delete(this.reads.keys().next().value!)
          if (count >= 3)
            outcome = {
              ...outcome,
              output: {
                ...details(outcome.output),
                recovery: {
                  code: 'tool_read_repeated',
                  guidance:
                    'This read succeeded three times with identical data. Use the returned evidence to continue; do not repeat the same call. Job-status polling remains available.',
                },
              },
            }
        }
      }
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
