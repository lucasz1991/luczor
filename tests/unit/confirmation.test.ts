import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestConfirmation } from '@/services/confirmation'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))

describe('confirmation transport', () => {
  beforeEach(() => {
    native.invoke.mockReset()
    vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke: native.invoke }, confirm: vi.fn() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('waits for the installed dialog plugin and never treats a pending Promise as approval', async () => {
    let resolve!: (value: string) => void
    native.invoke.mockReturnValueOnce(new Promise<string>(done => (resolve = done)))
    const done = vi.fn()
    const confirmation = requestConfirmation('Sensible Aktion', 'Freigabe').then(result => {
      done(result)
      return result
    })
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledOnce())
    expect(done).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(native.invoke).toHaveBeenCalledWith(
      'plugin:dialog|message',
      {
        message: 'Sensible Aktion',
        title: 'Freigabe',
        kind: 'warning',
        buttons: { OkCancelCustom: ['Bestätigen', 'Abbrechen'] },
      },
      undefined
    )
    resolve('Bestätigen')
    await expect(confirmation).resolves.toEqual({ approved: true })
  })

  it.each(['Abbrechen', 'Cancel', undefined])(
    'does not approve a canceled or unknown native answer (%s)',
    async answer => {
      native.invoke.mockResolvedValueOnce(answer)
      await expect(requestConfirmation('Sensible Aktion')).resolves.toEqual({ approved: false })
    }
  )

  it('turns a denied or unavailable native command into visible failure and no approval', async () => {
    native.invoke.mockRejectedValueOnce(new Error('dialog.message not allowed'))
    await expect(requestConfirmation('Sensible Aktion')).resolves.toEqual({
      approved: false,
      error: expect.stringContaining('Die Aktion wurde nicht freigegeben.'),
    })
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('awaits browser confirmations too and safely handles a rejected async shim', async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('unavailable'))
    vi.stubGlobal('window', { confirm })
    await expect(requestConfirmation('Erste Aktion')).resolves.toEqual({ approved: false })
    await expect(requestConfirmation('Zweite Aktion')).resolves.toMatchObject({
      approved: false,
      error: expect.any(String),
    })
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it('grants the installed message command only to the trusted main window', () => {
    const capability = (json: string) =>
      JSON.parse(json) as {
        windows: string[]
        permissions: string[]
        remote?: unknown
      }
    const main = capability(readFileSync('src-tauri/capabilities/default.json', 'utf8'))
    const browser = capability(readFileSync('src-tauri/capabilities/browser.json', 'utf8'))
    const miniChat = capability(readFileSync('src-tauri/capabilities/mini-chat.json', 'utf8'))
    expect(main.windows).toEqual(['main'])
    expect(main.remote).toBeUndefined()
    expect(main.permissions).toContain('dialog:allow-message')
    expect(browser.permissions.some(permission => permission.startsWith('dialog:'))).toBe(false)
    expect(miniChat.permissions.some(permission => permission.startsWith('dialog:'))).toBe(false)
  })
})
