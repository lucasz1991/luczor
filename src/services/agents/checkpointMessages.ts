import type { WireMessage } from '@/services/inference/types'

function freezeTree<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const child of Object.values(value)) freezeTree(child, seen)
    Object.freeze(value)
  }
  return value
}

/** Callers replace a record when its meaning changes; never mutate a retained record. */
export function createCheckpointValueSnapshot<T extends object>() {
  const snapshots = new WeakMap<T, T>()
  return (value: T): T => {
    let snapshot = snapshots.get(value)
    if (!snapshot) {
      snapshot = freezeTree(structuredClone(value))
      snapshots.set(value, snapshot)
    }
    return snapshot
  }
}

/** Preserve stable immutable entry identities for cumulative write journals. */
export function createCheckpointEntrySnapshot<T>() {
  const snapshots = new Map<string, { source: T; entry: [string, T] }>()
  return (entries: Iterable<readonly [string, T]>): [string, T][] =>
    Array.from(entries, ([key, value]) => {
      const previous = snapshots.get(key)
      if (previous?.source === value) return previous.entry
      const entry: [string, T] = [key, freezeTree(structuredClone(value))]
      Object.freeze(entry)
      snapshots.set(key, { source: value, entry })
      return entry
    })
}

/** Agent history is append/replace-only. Copy each object once, then share its
 * immutable snapshot between checkpoints without sharing mutable engine state. */
export function createCheckpointMessageSnapshot() {
  const snapshotValue = createCheckpointValueSnapshot<WireMessage>()
  return (messages: readonly WireMessage[]): WireMessage[] => messages.map(snapshotValue)
}
