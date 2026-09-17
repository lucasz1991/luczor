import { shallowRef } from 'vue'

export const resourceRecovery = shallowRef<{ message: string; revision: number } | null>(null)
let revision = 0
export function openResourceRecovery(message = 'Wie möchtest du die lokalen Modellressourcen verwalten?'): void {
  resourceRecovery.value = { message, revision: ++revision }
}
export function closeResourceRecovery(): void {
  resourceRecovery.value = null
}
