/** Retention and egress are separate decisions; local privacy does not imply volatility. */
export type SharedDataPolicy = 'syncable' | 'local_only' | 'ephemeral'
export const canPersistData = (policy: SharedDataPolicy): boolean => policy === 'syncable' || policy === 'local_only'
export const canEgressData = (policy: SharedDataPolicy): boolean => policy === 'syncable'
export function strictestDataPolicy(...policies: SharedDataPolicy[]): SharedDataPolicy {
  return policies.includes('ephemeral') ? 'ephemeral' : policies.includes('local_only') ? 'local_only' : 'syncable'
}
/**
 * Policy a later answer inherits from an earlier chat message. The legacy egress-only flag keeps a
 * message on this device; it was stored in full and therefore never made what follows volatile.
 */
export function inheritedMessageDataPolicy(meta: {
  retentionPolicy?: SharedDataPolicy
  dataHandling?: 'syncable' | 'ephemeral'
}): SharedDataPolicy {
  return meta.retentionPolicy ?? (meta.dataHandling === 'ephemeral' ? 'local_only' : 'syncable')
}
/**
 * A turn that failed or was stopped has no final classification. What it already showed stays on
 * this device; only a policy the run actually reached (`known`) can make it volatile. Leaving the
 * provisional `ephemeral` in place would drop the text and mark every later answer of the chat.
 */
export function unfinishedTurnDataPolicy(known?: SharedDataPolicy): SharedDataPolicy {
  return strictestDataPolicy('local_only', known ?? 'syncable')
}
