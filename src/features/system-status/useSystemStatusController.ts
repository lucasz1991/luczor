import { invoke } from '@tauri-apps/api/core'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { localModelDiagnostics } from '@/services/inference/localModelDiagnostics'
import {
  emptySystemStatusIndicators,
  localModelIndicator,
  systemStatusTabs,
  type SystemStatusDisplayMode,
  type SystemStatusIndicator,
  type SystemStatusIndicators,
  type SystemStatusSection,
} from './model'

type SystemStatusControllerProps = {
  active: boolean
  nativeWindow: boolean
  initialDisplayMode: Exclude<SystemStatusDisplayMode, 'mini'>
}

export function useSystemStatusController(props: SystemStatusControllerProps, close: () => void) {
  const displayMode = ref<SystemStatusDisplayMode>(props.initialDisplayMode)
  const activeSection = ref<SystemStatusSection>('resources')
  const indicators = ref<SystemStatusIndicators>(emptySystemStatusIndicators())
  const panel = ref<HTMLElement | null>(null)
  const content = ref<HTMLElement | null>(null)
  const modelOpen = ref(false)
  const profileOpen = ref(false)
  let previousFocus: HTMLElement | null = null

  function applyDisplayMode(mode: SystemStatusDisplayMode) {
    displayMode.value = mode
    if (mode === 'mini') activeSection.value = 'resources'
    if (content.value) content.value.scrollTop = 0
  }

  async function setDisplayMode(mode: SystemStatusDisplayMode) {
    if (mode === 'mini') {
      applyDisplayMode(mode)
      return
    }
    if (props.nativeWindow) {
      applyDisplayMode(mode)
      try {
        await invoke('system_status_window_set_mode', { mode })
      } catch {
        // Browser previews keep the selected responsive view without a native bridge.
      }
      return
    }
    try {
      await invoke('system_status_window_open', { mode })
      close()
    } catch {
      // Synthetic previews do not have a native window manager.
      applyDisplayMode(mode)
    }
  }

  function statusFor(section: SystemStatusSection): SystemStatusIndicator {
    switch (section) {
      case 'localmodel':
        return localModelIndicator(localModelDiagnostics.state.runs[0])
      case 'resources':
        return indicators.value.resources
      case 'memory':
        return indicators.value.memory
      case 'network':
        return indicators.value.network
      case 'details':
        return indicators.value.details
    }
  }

  async function selectSection(section: SystemStatusSection, focus = false) {
    activeSection.value = section
    await nextTick()
    if (content.value) content.value.scrollTop = 0
    if (focus && props.active) panel.value?.querySelector<HTMLButtonElement>(`#system-tab-${section}`)?.focus()
  }

  function onTabKeydown(event: KeyboardEvent, section: SystemStatusSection) {
    const index = systemStatusTabs.findIndex(tab => tab.id === section)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (index + 1) % systemStatusTabs.length
        break
      case 'ArrowLeft':
        nextIndex = (index + systemStatusTabs.length - 1) % systemStatusTabs.length
        break
      case 'Home':
        nextIndex = 0
        break
      case 'End':
        nextIndex = systemStatusTabs.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
    const next = systemStatusTabs.at(nextIndex)
    if (next) void selectSection(next.id, true)
  }

  function restoreFocus() {
    if (panel.value?.contains(document.activeElement) || document.activeElement === document.body) {
      previousFocus?.focus({ preventScroll: true })
    }
  }

  watch(
    () => props.initialDisplayMode,
    mode => {
      if (props.nativeWindow) applyDisplayMode(mode)
    }
  )
  watch(
    () => props.active,
    async active => {
      if (!active) {
        restoreFocus()
        return
      }
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      await nextTick()
      if (props.active) panel.value?.focus({ preventScroll: true })
    },
    { immediate: true }
  )
  onBeforeUnmount(restoreFocus)

  return {
    activeSection,
    content,
    displayMode,
    indicators,
    modelOpen,
    onTabKeydown,
    panel,
    profileOpen,
    selectSection,
    setDisplayMode,
    statusFor,
  }
}
