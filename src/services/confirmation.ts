export type ConfirmationResult = { approved: boolean; error?: string }

/** A native dialog is asynchronous. Only its resolved boolean can grant approval. */
export async function requestConfirmation(message: string, title = 'Luczor'): Promise<ConfirmationResult> {
  try {
    if (typeof window === 'undefined') throw new Error('Dialogoberfläche ist nicht verfügbar.')
    let approved: boolean
    if ('__TAURI_INTERNALS__' in window) {
      // Use the installed plugin API explicitly, not Tauri's async window.confirm shim.
      const { confirm } = await import('@tauri-apps/plugin-dialog')
      approved = await confirm(message, { title, kind: 'warning', okLabel: 'Bestätigen', cancelLabel: 'Abbrechen' })
    } else {
      approved = await window.confirm(message)
    }
    return { approved: approved === true }
  } catch {
    return {
      approved: false,
      error:
        'Der Bestätigungsdialog konnte nicht geöffnet werden. Die Aktion wurde nicht freigegeben. Bitte Luczor aktualisieren und neu starten.',
    }
  }
}
