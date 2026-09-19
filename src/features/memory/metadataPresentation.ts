import type { MemoryKind, MemoryMetadata } from '@/services/memory/memoryMetadata'

export const memoryKindLabels: Record<MemoryKind, string> = {
  unknown: 'Noch nicht eingeordnet',
  fact: 'Sachverhalt',
  preference: 'Präferenz',
  decision: 'Entscheidung',
  rule: 'Regel',
  hypothesis: 'Vermutung',
  observation: 'Beobachtung',
}
export const evidenceLabels: Record<MemoryMetadata['evidence']['status'], string> = {
  unknown: 'Beleglage unbekannt',
  user_stated: 'Nutzeraussage',
  inferred: 'KI-Ableitung',
  source_backed: 'Mit Quellenbezug',
  conflicting: 'Widersprüchliche Belege',
  stale: 'Belege nicht mehr aktuell',
}
export const classificationOriginLabels: Record<MemoryMetadata['classification']['origin'], string> = {
  capture: 'Beim Speichern eingeordnet',
  dream: 'Beim Träumen eingeordnet',
  user: 'Manuell eingeordnet',
}
export function memoryMetadataDescription(metadata?: MemoryMetadata): string {
  if (!metadata) return 'Einordnung: noch ausstehend'
  return [
    `Art: ${memoryKindLabels[metadata.kind]} · Beleglage: ${evidenceLabels[metadata.evidence.status]}`,
    `Persönliches Interesse: ${metadata.interest === null ? 'unbekannt' : `${Math.round(metadata.interest * 100)} %`}`,
    `Kategorien: ${metadata.categories.map(category => category.path.join(' › ')).join('; ') || 'noch offen'}`,
    `${classificationOriginLabels[metadata.classification.origin]}: ${new Date(metadata.classification.updatedAt).toLocaleString('de-DE')}`,
    ...(metadata.evidence.verifiedAt !== null
      ? [`Belegprüfung: ${new Date(metadata.evidence.verifiedAt).toLocaleString('de-DE')}`]
      : []),
    ...metadata.files.map(
      file =>
        `Datei (${file.relation === 'evidence' ? 'Beleg' : file.relation === 'related' ? 'Bezug' : 'Erwähnung'}): ${file.path}${file.revision ? ` · ${file.revision}` : ''}`
    ),
  ].join('\n')
}
