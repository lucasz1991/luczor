/** Structured memory describes evidence; it never grants instructions or permissions. */
export const MEMORY_METADATA_POLICY = 'memory-metadata-v1' as const
export const MEMORY_KINDS = ['unknown', 'fact', 'preference', 'decision', 'rule', 'hypothesis', 'observation'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]
export type MemoryCategory = { id: string; path: string[] }
export type MemoryFileReference = {
  projectId?: string
  repositoryId?: string
  path: string
  relation: 'mentioned' | 'related' | 'evidence'
  revision?: string
  verifiedAt?: number
}
export type MemoryEvidenceSource = {
  kind: 'chat' | 'memory' | 'file' | 'user'
  id: string
  role?: 'user' | 'assistant' | 'tool'
  revision?: string
  conversationId?: string
  projectId?: string
  observedAt?: number
}
export type MemoryClassification = {
  kind?: MemoryKind
  interest?: number | null
  categories?: string[][]
  tags?: string[]
  importance?: number
}
export type MemoryOriginContext = {
  messageId?: string
  conversationId?: string
  runId?: string
  role?: 'user' | 'assistant' | 'tool'
  observedAt?: number
  files?: MemoryFileReference[]
}
export type MemoryMetadata = {
  version: 1
  kind: MemoryKind
  interest: number | null
  categories: MemoryCategory[]
  files: MemoryFileReference[]
  evidence: {
    status: 'unknown' | 'user_stated' | 'inferred' | 'source_backed' | 'conflicting' | 'stale'
    verifiedAt: number | null
    sources: MemoryEvidenceSource[]
  }
  classification: {
    origin: 'capture' | 'dream' | 'user'
    updatedAt: number
    policy: typeof MEMORY_METADATA_POLICY
    inputRevision?: string
    modelId?: string
  }
  overrides: Array<keyof MemoryClassification>
}
type MetadataRecord = {
  content?: string
  contentHash?: string
  source?: string
  writeIntent?: string
  projectId?: string
  meta?: Record<string, unknown>
  tags?: string[]
  importance?: number
}
const fields = ['kind', 'interest', 'categories', 'tags', 'importance'] as const
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f]/u.test(value)
const score = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const unique = <T>(items: T[], key: (item: T) => string): T[] => [
  ...new Map(items.map(item => [key(item), item])).values(),
]
const aliases: Record<string, string> = {
  softwareentwicklung: 'Software',
  software: 'Software',
  programming: 'Software',
  backend: 'Backend',
  frontend: 'Frontend',
  datenbanken: 'Datenbanken',
  databases: 'Datenbanken',
  dokumentation: 'Dokumentation',
  documentation: 'Dokumentation',
  laravel: 'Laravel',
  livewire: 'Livewire',
  php: 'PHP',
  vue: 'Vue',
  'vue.js': 'Vue',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  tauri: 'Tauri',
}
export function memoryCategory(path: string[]): MemoryCategory {
  const labels = path.map(label => {
    const clean = label.normalize('NFC').trim().replace(/\s+/gu, ' ')
    const key = clean.toLocaleLowerCase('de')
    return Object.hasOwn(aliases, key) ? String(Reflect.get(aliases, key)) : clean
  })
  return {
    id: labels
      .map(label =>
        encodeURIComponent(label.toLocaleLowerCase('de')).replace(
          /[!'()*]/gu,
          character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        )
      )
      .join('/'),
    path: labels,
  }
}
/** Unknown fields must be rejected, especially model-supplied trust, sources and ownership. */
export function parseMemoryClassification(value: unknown): MemoryClassification {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key as keyof MemoryClassification)))
    throw new Error('invalid_memory_classification')
  const result: MemoryClassification = {}
  if ('kind' in value) {
    if (!MEMORY_KINDS.includes(value.kind as MemoryKind)) throw new Error('invalid_memory_kind')
    result.kind = value.kind as MemoryKind
  }
  for (const field of ['interest', 'importance'] as const) {
    if (!(field in value)) continue
    const proposed = Reflect.get(value, field)
    if (field === 'interest' && proposed === null) result.interest = null
    else if (score(proposed)) Reflect.set(result, field, proposed)
    else throw new Error(`invalid_memory_${field}`)
  }
  if ('categories' in value) {
    if (
      !Array.isArray(value.categories) ||
      value.categories.length > 8 ||
      value.categories.some(
        path => !Array.isArray(path) || !path.length || path.length > 4 || path.some(label => !boundedString(label, 80))
      )
    )
      throw new Error('invalid_memory_categories')
    result.categories = unique(
      value.categories.map(path => memoryCategory(path as string[])),
      item => item.id
    ).map(item => item.path)
  }
  if ('tags' in value) {
    if (!Array.isArray(value.tags) || value.tags.length > 32 || value.tags.some(tag => !boundedString(tag, 80)))
      throw new Error('invalid_memory_tags')
    result.tags = unique(
      value.tags.map(tag => (tag as string).trim()),
      tag => tag.toLocaleLowerCase('de')
    )
  }
  return result
}
export const normalizeMemoryClassification = parseMemoryClassification

function validFile(value: unknown): value is MemoryFileReference {
  return (
    object(value) &&
    boundedString(value.path, 2048) &&
    ['mentioned', 'related', 'evidence'].includes(String(value.relation)) &&
    ['projectId', 'repositoryId', 'revision'].every(
      key => Reflect.get(value, key) === undefined || boundedString(Reflect.get(value, key), 512)
    ) &&
    (value.verifiedAt === undefined || timestamp(value.verifiedAt)) &&
    (value.relation !== 'evidence' || (boundedString(value.revision, 512) && timestamp(value.verifiedAt)))
  )
}
function validSource(value: unknown): value is MemoryEvidenceSource {
  return (
    object(value) &&
    ['chat', 'memory', 'file', 'user'].includes(String(value.kind)) &&
    boundedString(value.id, 512) &&
    (value.role === undefined || ['user', 'assistant', 'tool'].includes(String(value.role))) &&
    ['revision', 'conversationId', 'projectId'].every(
      key => Reflect.get(value, key) === undefined || boundedString(Reflect.get(value, key), 512)
    ) &&
    (value.observedAt === undefined || timestamp(value.observedAt))
  )
}
export function normalizeMemoryMetadata(value: unknown): MemoryMetadata | undefined {
  if (!object(value) || value.version !== 1 || !object(value.evidence) || !object(value.classification))
    return undefined
  try {
    const classification = parseMemoryClassification({
      kind: value.kind,
      interest: value.interest,
      categories: Array.isArray(value.categories)
        ? value.categories.map(category => (object(category) ? category.path : null))
        : null,
    })
    if (
      !Array.isArray(value.files) ||
      value.files.length > 32 ||
      !value.files.every(validFile) ||
      !Array.isArray(value.evidence.sources) ||
      value.evidence.sources.length > 32 ||
      !value.evidence.sources.every(validSource) ||
      !['unknown', 'user_stated', 'inferred', 'source_backed', 'conflicting', 'stale'].includes(
        String(value.evidence.status)
      ) ||
      (value.evidence.verifiedAt !== null && !timestamp(value.evidence.verifiedAt)) ||
      !['capture', 'dream', 'user'].includes(String(value.classification.origin)) ||
      value.classification.policy !== MEMORY_METADATA_POLICY ||
      !timestamp(value.classification.updatedAt) ||
      (value.classification.inputRevision !== undefined && !boundedString(value.classification.inputRevision, 512)) ||
      (value.classification.modelId !== undefined && !boundedString(value.classification.modelId, 512)) ||
      !Array.isArray(value.overrides) ||
      value.overrides.some(field => !fields.includes(field as keyof MemoryClassification))
    )
      return undefined
    return {
      version: 1,
      kind: classification.kind!,
      interest: classification.interest!,
      categories: classification.categories!.map(memoryCategory),
      files: value.files.map(file => ({ ...file })),
      evidence: {
        ...value.evidence,
        sources: value.evidence.sources.map(source => ({ ...source })),
      } as MemoryMetadata['evidence'],
      classification: { ...value.classification } as MemoryMetadata['classification'],
      overrides: [...new Set(value.overrides)] as MemoryMetadata['overrides'],
    }
  } catch {
    return undefined
  }
}
export function memoryMetadataOf(record: { meta?: Record<string, unknown> }): MemoryMetadata | undefined {
  return normalizeMemoryMetadata(record.meta?.memory_metadata)
}
function inferredKind(content: string): MemoryKind {
  if (/\b(vielleicht|vermutlich|hypothese|possibly|hypothesis)\b/iu.test(content)) return 'hypothesis'
  if (/\b(bevorzuge|präferiere|prefer|lieber|preference)\b/iu.test(content)) return 'preference'
  if (/\b(entschieden|entscheidung|beschlossen|decision|decided)\b/iu.test(content)) return 'decision'
  if (/\b(immer|niemals|muss|dürfen nicht|always|never|must)\b/iu.test(content)) return 'rule'
  return 'unknown'
}
function inferredCategories(content: string): string[][] {
  const paths: string[][] = []
  for (const [pattern, path] of [
    [/\blaravel\b/iu, ['Software', 'Backend', 'Laravel']],
    [/\blivewire\b/iu, ['Software', 'Frontend', 'Livewire']],
    [/\bphp\b/iu, ['Software', 'Backend', 'PHP']],
    [/\bvue(?:\.js)?\b/iu, ['Software', 'Frontend', 'Vue']],
    [/\btypescript\b/iu, ['Software', 'TypeScript']],
    [/\btauri\b/iu, ['Software', 'Tauri']],
  ] as Array<[RegExp, string[]]>)
    if (pattern.test(content)) paths.push(path)
  return paths
}
export function captureMemoryMetadata(
  input: MetadataRecord & {
    content: string
    origin?: MemoryOriginContext
    classification?: MemoryClassification
    now?: number
  }
): MemoryMetadata {
  const now = input.now ?? Date.now()
  const origin = input.origin
  const user = origin?.role ? origin.role === 'user' : input.source === 'user'
  const hints = input.classification ? parseMemoryClassification(input.classification) : {}
  const files = (origin?.files ?? [])
    .filter(validFile)
    .filter(file => !file.projectId || file.projectId === input.projectId)
  // Quoted path mentions are useful for search, but are never evidence of file existence.
  for (const match of input.content.matchAll(/`([^`\r\n]{1,2048})`/gu)) {
    const path = match[1]!
    if ((/[\\/]/u.test(path) || /\.[a-z0-9]{1,8}$/iu.test(path)) && !/\s|:\/\//u.test(path) && files.length < 32)
      files.push({ path, projectId: input.projectId, relation: 'mentioned' })
  }
  const interest =
    user && /\b(interessiere mich|interessiert mich|mein schwerpunkt|my interest|interested in)\b/iu.test(input.content)
      ? 0.8
      : null
  const sources: MemoryEvidenceSource[] = origin?.messageId
    ? [
        {
          kind: 'chat',
          id: origin.messageId,
          role: origin.role ?? (user ? 'user' : 'assistant'),
          conversationId: origin.conversationId,
          projectId: input.projectId,
          observedAt: origin.observedAt ?? now,
        },
      ]
    : []
  const verified = files.filter(file => file.relation === 'evidence')
  return {
    version: 1,
    kind: hints.kind ?? inferredKind(input.content),
    interest: user ? (hints.interest ?? interest) : null,
    categories: (hints.categories ?? inferredCategories(input.content)).map(memoryCategory),
    files: unique(files, file =>
      JSON.stringify([file.repositoryId, file.projectId, file.path, file.relation, file.revision])
    ).slice(0, 32),
    evidence: {
      status: verified.length ? 'source_backed' : user ? 'user_stated' : input.source ? 'inferred' : 'unknown',
      verifiedAt: verified.length ? Math.min(...verified.map(file => file.verifiedAt!)) : null,
      sources,
    },
    classification: { origin: 'capture', updatedAt: now, policy: MEMORY_METADATA_POLICY },
    overrides: [],
  }
}

/** Re-evaluation identity excludes the classifier's own output and its edit timestamp. */
export function memoryMetadataInputRevision(record: MetadataRecord): string {
  const metadata =
    memoryMetadataOf(record) ?? captureMemoryMetadata({ ...record, content: record.content ?? '', now: 0 })
  const overrides = metadata.overrides.map(field => [
    field,
    field === 'tags' ? record.tags : field === 'importance' ? record.importance : Reflect.get(metadata, field),
  ])
  const material = JSON.stringify([
    MEMORY_METADATA_POLICY,
    record.contentHash ?? record.content ?? '',
    record.source,
    record.writeIntent,
    record.projectId,
    metadata.evidence,
    metadata.files,
    overrides,
  ])
  // Bounded scheduling key only. Commit authority always uses the complete record revision/CAS.
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < material.length; index++)
    hash = BigInt.asUintN(64, (hash ^ BigInt(material.charCodeAt(index))) * 0x100000001b3n)
  return `m1:${material.length}:${hash.toString(16).padStart(16, '0')}`
}
export function needsMemoryAnnotation(record: MetadataRecord): boolean {
  return memoryMetadataOf(record)?.classification.inputRevision !== memoryMetadataInputRevision(record)
}
export function applyMemoryAnnotation(
  record: MetadataRecord,
  value: MemoryClassification,
  options: {
    origin: 'dream' | 'user'
    now?: number
    modelId?: string
    inputRevision?: string
  }
): { meta: Record<string, unknown>; tags: string[]; importance: number } {
  const patch = parseMemoryClassification(value)
  const now = options.now ?? Date.now()
  const current = memoryMetadataOf(record) ?? captureMemoryMetadata({ ...record, content: record.content ?? '', now })
  const metadata: MemoryMetadata = structuredClone(current)
  const allowed = (field: keyof MemoryClassification) =>
    options.origin === 'user' || !metadata.overrides.includes(field)
  for (const field of ['kind', 'interest', 'categories'] as const) {
    if (Reflect.get(patch, field) === undefined || !allowed(field)) continue
    if (field === 'categories') metadata.categories = patch.categories!.map(memoryCategory)
    else if (field === 'kind') metadata.kind = patch.kind!
    else if (
      options.origin === 'user' ||
      record.source === 'user' ||
      metadata.evidence.sources.some(source => source.role === 'user')
    )
      metadata.interest = patch.interest!
  }
  const tags = patch.tags !== undefined && allowed('tags') ? patch.tags : [...(record.tags ?? [])]
  // Internal lineage tags are not a classification field and survive user/model edits.
  for (const tag of record.tags ?? [])
    if (['maintenance-derived', 'idle-optimization', 'checkpoint'].includes(tag) && !tags.includes(tag)) tags.push(tag)
  const importance =
    patch.importance !== undefined && allowed('importance') ? patch.importance : (record.importance ?? 0.5)
  if (options.origin === 'user')
    metadata.overrides = [
      ...new Set([...metadata.overrides, ...(Object.keys(patch) as Array<keyof MemoryClassification>)]),
    ]
  metadata.classification = {
    origin: options.origin,
    updatedAt: now,
    policy: MEMORY_METADATA_POLICY,
    ...(options.modelId ? { modelId: options.modelId } : {}),
  }
  const result = { meta: { ...record.meta, memory_metadata: metadata }, tags, importance }
  if (options.origin === 'dream')
    metadata.classification.inputRevision =
      options.inputRevision ?? memoryMetadataInputRevision({ ...record, ...result })
  return result
}
export function mergeMemoryMetadata(records: MetadataRecord[], now = Date.now()): MemoryMetadata {
  const entries = records.map(
    record => memoryMetadataOf(record) ?? captureMemoryMetadata({ ...record, content: record.content ?? '', now })
  )
  const merged = captureMemoryMetadata({ content: '', source: 'assistant', now })
  merged.kind = entries.length && entries.every(entry => entry.kind === entries[0]!.kind) ? entries[0]!.kind : 'unknown'
  // A preference about one topic is not evidence of interest in every merged topic.
  const topic = (entry: MemoryMetadata) => JSON.stringify(entry.categories.map(category => category.id).sort())
  const sameTopic =
    entries.length > 0 &&
    entries[0]!.categories.length > 0 &&
    entries.every(entry => topic(entry) === topic(entries[0]!))
  merged.interest =
    sameTopic && entries.every(entry => entry.interest !== null)
      ? entries.reduce((sum, entry) => sum + entry.interest!, 0) / entries.length
      : null
  merged.categories = unique(
    entries.flatMap(entry => entry.categories),
    category => category.id
  )
  merged.files = unique(
    entries.flatMap(entry => entry.files),
    file => JSON.stringify([file.projectId, file.repositoryId, file.path, file.relation, file.revision])
  )
  merged.evidence.sources = unique(
    entries.flatMap(entry => entry.evidence.sources),
    source => JSON.stringify([source.kind, source.id, source.revision])
  )
  if (merged.categories.length > 8 || merged.files.length > 32 || merged.evidence.sources.length > 32)
    throw new Error('memory_metadata_merge_too_large')
  for (const field of fields) {
    const protectedValues = entries.flatMap((entry, index) =>
      entry.overrides.includes(field)
        ? [
            JSON.stringify(
              field === 'tags'
                ? records.at(index)!.tags
                : field === 'importance'
                  ? records.at(index)!.importance
                  : Reflect.get(entry, field)
            ),
          ]
        : []
    )
    if (new Set(protectedValues).size > 1) throw new Error('memory_metadata_override_conflict')
  }
  // A synthesized text has not been verified merely because its ingredients were.
  merged.evidence.status = entries.some(entry => entry.evidence.status === 'conflicting') ? 'conflicting' : 'inferred'
  merged.overrides = [...new Set(entries.flatMap(entry => entry.overrides))]
  for (const field of ['kind', 'interest', 'categories'] as const) {
    const protectedEntries = entries.filter(entry => entry.overrides.includes(field))
    if (
      protectedEntries.length &&
      protectedEntries.every(
        entry => JSON.stringify(Reflect.get(entry, field)) === JSON.stringify(Reflect.get(protectedEntries[0]!, field))
      )
    ) {
      if (field === 'kind') merged.kind = protectedEntries[0]!.kind
      else if (field === 'interest') merged.interest = protectedEntries[0]!.interest
      else merged.categories = protectedEntries[0]!.categories
    }
  }
  return merged
}
export function memoryMetadataSearchText(record: MetadataRecord): string {
  const metadata = memoryMetadataOf(record)
  return [
    ...(record.tags ?? []),
    ...(metadata?.categories.flatMap(category => category.path) ?? []),
    ...(metadata?.files.map(file => file.path) ?? []),
  ].join(' ')
}
