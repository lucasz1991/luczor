import { describe, expect, it, vi } from 'vitest'
import {
  createPlanPrincipalBinding,
  isPlanningDiscussion,
  planningCommandObjective,
  planningDiscussionMessage,
} from '@/services/planningEntry'

describe('planning entry and account binding', () => {
  it('turns a planning objective into a normal collaborative chat request', () => {
    const message = planningDiscussionMessage('  Dateiänderungen planen\nmit Tests  ')
    expect(message).toContain('Dateiänderungen planen\nmit Tests')
    expect(message).toContain('die Punkte gemeinsam besprechen')
    expect(message).toContain('benötigt einen eigenen klaren Auftrag')
    expect(message).toContain('Planungsfenster nutzen wir nur auf Wunsch')
    expect(planningDiscussionMessage('  ')).toContain('das aktuelle Projekt')
    expect(isPlanningDiscussion(message)).toBe(true)
    expect(isPlanningDiscussion(planningDiscussionMessage('Implementiere den Plan jetzt'))).toBe(true)
  })

  it.each([
    '/plan',
    '/planung Datenbankwechsel',
    'Plane bitte das neue Feature.',
    'Erstelle bitte einen Plan, wie wir alte Dateien löschen können.',
    'Bitte erstelle einen Plan für die Umsetzung.',
    'Plan erstellen',
    'Lass uns die Punkte erst gemeinsam besprechen.',
    'Welche Varianten gibt es für Schritt 2?',
    'Wie würdest du den Plan umsetzen?',
    'Bitte den Plan besprechen und noch nicht ausführen.',
    'Den Plan noch nicht umsetzen.',
    'Erörtere die Varianten des Plans und die nächsten Schritte.',
    'Erstelle bitte einen Plan. Danach besprechen wir die Punkte.',
  ])('recognizes pure planning discussion: %s', text => {
    expect(isPlanningDiscussion(text)).toBe(true)
  })

  it.each([
    'Plan jetzt umsetzen',
    'Setze den Plan jetzt um.',
    'Bitte den Plan ausführen.',
    'Plane die Änderung und setze sie danach um.',
    'Plane die Lösung und erstelle eine Datei.',
    'Prüfe die Dateien für den Plan.',
    'Bitte den Plan prüfen.',
    'Lies notes.md für die Planung.',
    'Aktualisiere den Plan um einen Testschritt.',
    'Ändere den Plan und diskutiere die Schritte.',
    'Öffne den Plan, danach die Punkte besprechen.',
    'Speichere den Plan.',
    'Erstelle plan.md.',
    'Wie geht es dir?',
    '/planet erkunden',
  ])('keeps concrete execution or inspection requests outside discussion: %s', text => {
    expect(isPlanningDiscussion(text)).toBe(false)
  })

  it('separates complete planning commands from ordinary chat and preserves multiline objectives', () => {
    expect(planningCommandObjective('/plan')).toBe('')
    expect(planningCommandObjective(' /Plan Prüfe das Projekt\nund seine Tests. ')).toBe(
      'Prüfe das Projekt\nund seine Tests.'
    )
    expect(planningCommandObjective('/planung Neues Feature')).toBe('Neues Feature')
    expect(planningCommandObjective('/planet entdecken')).toBeNull()
    expect(planningCommandObjective('Erkläre /plan')).toBeNull()
  })

  it('does not rebind an old account when identity resolution finishes after a switch', async () => {
    let finish: (value: string) => void = () => {}
    const bind = vi.fn()
    const resolve = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>(done => {
            finish = done
          })
      )
      .mockResolvedValueOnce('account:new')
    const binding = createPlanPrincipalBinding(resolve, bind)
    const old = binding.refresh()
    binding.invalidate()
    await binding.refresh()
    finish('account:old')
    await old
    expect(bind).not.toHaveBeenCalledWith('account:old')
    expect(bind).toHaveBeenLastCalledWith('account:new')
    binding.dispose()
    await binding.refresh()
    expect(bind).toHaveBeenLastCalledWith(null)
    expect(resolve).toHaveBeenCalledTimes(2)
  })
})
