/** Ephemeral aliases for paths already observed through authorized file tools.
 * References select a file; they never grant access or bypass native validation.
 */
export class FileReferences {
  private entries = new Map<string, { scope: string; path: string; expires: number }>()
  private prune() {
    for (const [id, entry] of this.entries) if (entry.expires <= Date.now()) this.entries.delete(id)
  }

  remember(scope: string, path: string): string {
    this.prune()
    for (const [id, entry] of this.entries) {
      if (entry.scope === scope && entry.path === path) {
        entry.expires = Date.now() + 60 * 60_000
        return id
      }
    }
    while (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!)
    const id = `file_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    this.entries.set(id, { scope, path, expires: Date.now() + 60 * 60_000 })
    return id
  }

  resolve(scope: string, reference: unknown): string {
    this.prune()
    const entry = typeof reference === 'string' ? this.entries.get(reference) : undefined
    if (!entry || entry.scope !== scope)
      throw new Error('file_reference_unavailable: Run fs_list or fs_search again and copy a current file_ref exactly.')
    return entry.path
  }
}
