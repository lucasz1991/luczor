import type { MiniSnapshot } from './types'

export type OrbPhase = 'idle' | 'thinking' | 'executing' | 'waiting' | 'speaking' | 'listening' | 'error' | 'done' | 'stopped'
export function miniStatus(state: MiniSnapshot, unread = false): { phase: OrbPhase; label: string; detail: string } {
  if (state.hud.killSwitch) return { phase: 'stopped', label: 'Not-Aus aktiv', detail: 'Werkzeuge sind gesperrt' }
  if (state.decision || state.mainDecision) return { phase: 'waiting', label: 'Deine Entscheidung', detail: state.decision?.title ?? state.mainDecision!.title }
  if (state.busy) {
    const executing = state.tools.some(tool => tool.status === 'executing')
    const last = state.messages[state.messages.length - 1]
    const steps = last?.activity?.steps ?? []
    return { phase: executing ? 'executing' : 'thinking', label: executing ? 'Führt aus' : 'Verarbeitet', detail: steps[steps.length - 1]?.detail ?? steps[steps.length - 1]?.label ?? 'Anfrage vorbereiten' }
  }
  if (state.hud.status === 'listening') return { phase: 'listening', label: 'Hört zu', detail: 'Mikrofon im Hauptfenster aktiv' }
  if (state.hud.status === 'speaking') return { phase: 'speaking', label: 'Spricht', detail: 'Sprachausgabe läuft' }
  if (state.mainBusy) return { phase: state.hud.status === 'executing' ? 'executing' : 'thinking', label: 'Projektchat arbeitet', detail: 'Du kannst hier Freigaben beantworten' }
  const last = state.messages[state.messages.length - 1]
  if (last?.status === 'failed') return { phase: 'error', label: 'Anfrage fehlgeschlagen', detail: 'Chat öffnen und erneut versuchen' }
  if (unread) return { phase: 'done', label: 'Neue Antwort', detail: 'Zum Lesen öffnen' }
  return { phase: 'idle', label: 'Bereit', detail: 'Klicken zum Schreiben · Ziehen zum Verschieben' }
}
