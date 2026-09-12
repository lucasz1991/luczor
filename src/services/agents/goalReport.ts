import type { ToolDef } from '@/services/tools/types'
import { validateToolArguments } from '@/services/tools/validateArguments'

export type GoalReport = {
  status: 'continue' | 'candidate' | 'completed' | 'blocked'
  summary: string
  evidence?: string
}

/** A local callback owned by one root goal turn, never part of an inference request. */
export type GoalTracking = {
  phase: 'work' | 'review'
  report: (result: GoalReport) => void
}

export const GOAL_REPORT_NAME = 'goal_report'
export const GOAL_REPORT_MARKER = '[LUCZOR-ZIELBERICHT]'

export function goalReportInstruction(phase: GoalTracking['phase']): string {
  return [
    `${GOAL_REPORT_MARKER} Melde vor deiner abschließenden öffentlichen Antwort den belegten Stand mit goal_report.`,
    phase === 'work'
      ? 'Arbeitsphase: continue für verbleibende Arbeit, candidate für ein prüfbares Ergebnis, blocked für ein konkret belegtes Hindernis. Du kannst das Ziel nicht selbst als completed bestätigen.'
      : 'Prüfphase: Prüfe Ergebnis und Abnahmekriterien unabhängig. completed verlangt einen konkreten, nichtleeren Nachweis; bei fehlenden Belegen continue oder blocked verwenden.',
    'summary beschreibt knapp den öffentlichen Arbeitsstand, evidence die tatsächlich geprüften Ergebnisse. Keine internen Denktexte. Die Meldung allein schließt den Auftrag nicht ab; der Aufrufer prüft zusätzlich den erfolgreichen Abschluss dieser Runde.',
  ].join(' ')
}

export function createGoalReportTool(tracking: GoalTracking): ToolDef {
  const phase = tracking.phase
  const report = tracking.report
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: {
        type: 'string',
        enum:
          phase === 'work' ? ['continue', 'candidate', 'blocked'] : ['continue', 'candidate', 'completed', 'blocked'],
      },
      summary: { type: 'string', minLength: 1, maxLength: 1200 },
      evidence: { type: 'string', maxLength: 4000 },
    },
    required: ['status', 'summary'],
  }
  return {
    name: GOAL_REPORT_NAME,
    category: 'app',
    description:
      'Record a bounded goal progress report for this root turn before the final answer. This is not proof of task completion. Work can propose candidate; only independent review can report completed with concrete evidence.',
    parameters,
    mutating: false,
    requiresApproval: false,
    dataHandling: 'ephemeral',
    scope: 'app',
    risk: 'low',
    effects: ['read'],
    async execute(args, context) {
      context.signal?.throwIfAborted()
      validateToolArguments(parameters, args)
      const status = args.status as GoalReport['status']
      const summary = (args.summary as string).trim()
      const evidence = typeof args.evidence === 'string' ? args.evidence.trim() : undefined
      if (!summary) throw new Error('Die Zielrückmeldung benötigt eine nichtleere Zusammenfassung.')
      if (status === 'completed' && (phase !== 'review' || !evidence))
        throw new Error('Nur eine unabhängige Prüfung mit konkretem Nachweis darf completed melden.')
      report({ status, summary, ...(evidence ? { evidence } : {}) })
      return { ok: true, reportRecorded: true, status }
    },
  }
}
