/** Retention and egress are separate decisions; local privacy does not imply volatility. */
export type SharedDataPolicy = 'syncable' | 'local_only' | 'ephemeral'
export const canPersistData = (policy: SharedDataPolicy): boolean => policy === 'syncable' || policy === 'local_only'
export const canEgressData = (policy: SharedDataPolicy): boolean => policy === 'syncable'
export function strictestDataPolicy(...policies: SharedDataPolicy[]): SharedDataPolicy {
  return policies.includes('ephemeral') ? 'ephemeral' : policies.includes('local_only') ? 'local_only' : 'syncable'
}
