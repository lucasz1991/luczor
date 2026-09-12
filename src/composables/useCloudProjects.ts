import { onBeforeUnmount, onMounted, watch } from 'vue'
import { state } from '@/state/store'
import { configureCloudProjectWorkload, listCloudProjects, syncCloudProjects } from '@/services/api/cloudProjects'

/** Opted-in projects synchronize after quiet periods, never between rounds of a live workload. */
export function useCloudProjects(busy: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  let inFlight = false
  let disposed = false
  const detach = configureCloudProjectWorkload(busy)
  const synchronize = async () => {
    if (disposed || inFlight || busy() || !state.projects.some(project => project.cloud && !project.cloud.paused))
      return
    inFlight = true
    try {
      await syncCloudProjects()
    } catch {
      /* The project panel retains the actionable error; offline work continues. */
    } finally {
      inFlight = false
    }
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void synchronize(), 5000)
  }
  const stop = watch(() => [state.projects, state.messages, state.global.memories, state.summaries, busy()], schedule, {
    deep: true,
  })
  const refreshIdentity = () => {
    void listCloudProjects().catch(() => undefined)
    schedule()
  }
  onMounted(() => {
    refreshIdentity()
    interval = setInterval(() => void synchronize(), 60000)
    window.addEventListener('luczor:api-identity-changed', refreshIdentity)
  })
  onBeforeUnmount(() => {
    disposed = true
    clearTimeout(timer)
    clearInterval(interval)
    stop()
    detach()
    window.removeEventListener('luczor:api-identity-changed', refreshIdentity)
  })
}
