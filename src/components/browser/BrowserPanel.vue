<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import AiIcon from '@/components/ai/AiIcon.vue'
import { browserFailure, browserPanel } from '@/services/browserPanel'
import { browserNavigationUrl } from '@/services/browserNavigation'
import { browserTools } from '@/services/tools/browser'
import { closePlaygroundNative, openPlaygroundNative, requestPlaygroundAction } from '@/services/chatPlaygroundNative'
import { closeToolSession, listToolSessions } from '@/services/tools/toolSessionCoordinator'
import ChatPlaygroundFiles from '@/components/browser/ChatPlaygroundFiles.vue'
import ChatPlaygroundTerminal from '@/components/browser/ChatPlaygroundTerminal.vue'
import { executionGate } from '@/services/executionGate'
import {
  appendPlaygroundTab,
  chatPlaygroundToolSessionId,
  closePlaygroundTab,
  getChatPlaygroundState,
  type ChatPlaygroundTab,
} from '@/services/chatPlayground'

const DESKTOP_WIDTH = 1600
const DESKTOP_HEIGHT = 900
const MIN_HEIGHT = 150
const DEFAULT_HEIGHT = 360

const props = defineProps<{
  projectId: string
  conversationId: string
  projectName: string
  workspaceName: string
  workspaceReady: boolean
  mode: 'observe' | 'act' | 'unrestricted'
  killSwitch: boolean
  suspended?: boolean
  detached?: boolean
}>()
defineEmits<{ bindFolder: [] }>()
const viewport = ref<HTMLElement | null>(null)
const address = ref('')
const currentUrl = ref('')
const opened = ref(false)
const busy = ref(false)
const dialogOpen = ref(false)
const panelHeight = ref(DEFAULT_HEIGHT)
const windowHeight = ref(typeof window === 'undefined' ? 900 : window.innerHeight)
const windowWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth)
const resizing = ref(false)
const native = typeof window !== 'undefined' && isTauri()
const expanded = computed(() => browserPanel.expanded)
const playground = computed(() => getChatPlaygroundState(props.projectId, props.conversationId))
const activeTab = computed(
  () => playground.value.tabs.find(tab => tab.id === playground.value.activeTabId) ?? playground.value.tabs[0]!
)
const isBrowserTab = computed(() => activeTab.value.kind === 'browser')
const showAddMenu = ref(false)
const floatingPoint = ref({ left: 72, top: 72 })
const floatingSize = ref({ width: 940, height: 680 })
const floatingDrag = ref<{ pointerX: number; pointerY: number; left: number; top: number } | null>(null)
const floatingResize = ref<{ pointerX: number; pointerY: number; width: number; height: number } | null>(null)
const maxHeight = computed(() => Math.max(MIN_HEIGHT, Math.min(760, Math.round(windowHeight.value * 0.64))))
const isFloating = computed(() => !props.detached && browserPanel.viewMode === 'window')
const visible = computed(
  () =>
    expanded.value &&
    isBrowserTab.value &&
    !!activeTab.value.url &&
    !props.suspended &&
    !dialogOpen.value &&
    (typeof document === 'undefined' || !document.hidden)
)
const panelStyle = computed(() => ({
  '--browser-workspace-height': `${Math.min(panelHeight.value, maxHeight.value)}px`,
  '--playground-left': `${floatingPoint.value.left}px`,
  '--playground-top': `${floatingPoint.value.top}px`,
  '--playground-width': `${Math.min(floatingSize.value.width, Math.max(360, windowWidth.value - floatingPoint.value.left - 16))}px`,
  '--playground-height': `${Math.min(floatingSize.value.height, Math.max(300, windowHeight.value - floatingPoint.value.top - 16))}px`,
}))
let resize: ResizeObserver | undefined
let mutations: MutationObserver | undefined
let timer: ReturnType<typeof setInterval> | undefined
let layoutFrame: number | undefined
let stopped = false
let polling = false
let resizeStartY = 0
let resizeStartHeight = DEFAULT_HEIGHT
let layoutQueue = Promise.resolve()
let browserSessionId = ''

type BrowserBounds = { left: number; top: number; width: number; height: number; zoom: number }

function clampHeight(next: number): void {
  panelHeight.value = Math.min(maxHeight.value, Math.max(MIN_HEIGHT, Math.round(next)))
}

function browserContext() {
  return {
    projectId: props.projectId,
    execution: executionGate.capture(
      undefined,
      { projectId: props.projectId, conversationId: props.conversationId },
      props.mode
    ),
    toolSessionId: chatPlaygroundToolSessionId(props.projectId, props.conversationId),
  }
}

function openTab(tab: ChatPlaygroundTab): void {
  appendPlaygroundTab(playground.value, tab)
  showAddMenu.value = false
  void nextTick(() => scheduleLayout())
}

function addBrowserTab(): void {
  const id = 'browser:' + crypto.randomUUID()
  openTab({ id, kind: 'browser', title: 'Browser' })
  address.value = ''
  opened.value = false
}

function addTerminalTab(): void {
  openTab({ id: 'terminal:' + crypto.randomUUID(), kind: 'terminal', title: 'Terminal' })
}

function openFile(file: { path: string; content: string }): void {
  openTab({
    id: 'file:' + file.path,
    kind: 'file',
    title: file.path.split('/').at(-1) || file.path,
    path: file.path,
    content: file.content,
  })
}

function removeTab(tabId: string): void {
  closePlaygroundTab(playground.value, tabId)
  void nextTick(() => scheduleLayout())
}

function toggleViewMode(): void {
  if (props.detached) {
    void closePlaygroundNative()
    return
  }
  if (native) {
    const payload = {
      projectId: props.projectId,
      conversationId: props.conversationId,
      projectName: props.projectName || 'Projekt',
      workspaceName: props.workspaceName,
      workspaceReady: props.workspaceReady,
      mode: props.mode,
      killSwitch: props.killSwitch,
    }
    void openPlaygroundNative(payload)
      .then(binding => {
        browserPanel.detached = true
        browserPanel.detachedSessionId = binding.sessionId
        browserPanel.expanded = false
      })
      .catch(error => {
        browserPanel.error = browserFailure(error)
      })
    return
  }
  browserPanel.viewMode = browserPanel.viewMode === 'mini' ? 'window' : 'mini'
  if (isFloating.value) {
    const mainColumn = document.querySelector('.app-shell.ai-workspace > .main-col')
    const mainBounds = mainColumn?.getBoundingClientRect()
    const left = Math.max(0, mainBounds?.left ?? 72)
    const top = Math.min(72, Math.max(0, windowHeight.value - 320))
    floatingSize.value = {
      width: Math.min(floatingSize.value.width, Math.max(360, windowWidth.value - left - 16)),
      height: Math.min(floatingSize.value.height, Math.max(300, windowHeight.value - top - 16)),
    }
    floatingPoint.value = {
      left: Math.min(left, Math.max(0, windowWidth.value - 380)),
      top,
    }
  }
  scheduleLayout()
}

function beginFloatingDrag(event: PointerEvent): void {
  if (browserPanel.viewMode !== 'window' || event.button !== 0) return
  if ((event.target as HTMLElement).closest('button,input,select,a')) return
  floatingDrag.value = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    left: floatingPoint.value.left,
    top: floatingPoint.value.top,
  }
  window.addEventListener('pointermove', moveFloatingWindow)
  window.addEventListener('pointerup', finishFloatingDrag)
  window.addEventListener('pointercancel', finishFloatingDrag)
}

function moveFloatingWindow(event: PointerEvent): void {
  if (!floatingDrag.value) return
  floatingPoint.value = {
    left: Math.max(
      0,
      Math.min(window.innerWidth - 220, floatingDrag.value.left + event.clientX - floatingDrag.value.pointerX)
    ),
    top: Math.max(
      0,
      Math.min(window.innerHeight - 100, floatingDrag.value.top + event.clientY - floatingDrag.value.pointerY)
    ),
  }
}

function finishFloatingDrag(): void {
  floatingDrag.value = null
  window.removeEventListener('pointermove', moveFloatingWindow)
  window.removeEventListener('pointerup', finishFloatingDrag)
  window.removeEventListener('pointercancel', finishFloatingDrag)
}

function beginFloatingResize(event: PointerEvent): void {
  if (!isFloating.value || event.button !== 0) return
  event.preventDefault()
  floatingResize.value = {
    pointerX: event.clientX,
    pointerY: event.clientY,
    width: floatingSize.value.width,
    height: floatingSize.value.height,
  }
  window.addEventListener('pointermove', resizePanel)
  window.addEventListener('pointerup', finishResize)
  window.addEventListener('pointercancel', finishResize)
}

function updateFloatingSize(width: number, height: number): void {
  floatingSize.value = {
    width: Math.max(360, Math.min(width, windowWidth.value - floatingPoint.value.left - 16)),
    height: Math.max(300, Math.min(height, windowHeight.value - floatingPoint.value.top - 16)),
  }
}

function browserBounds(): BrowserBounds | null {
  const rect = viewport.value?.getBoundingClientRect()
  if (!rect || rect.width < 20 || rect.height < 20) return null
  const zoom = Math.min(rect.width / DESKTOP_WIDTH, rect.height / DESKTOP_HEIGHT)
  if (!Number.isFinite(zoom) || zoom <= 0) return null
  const width = DESKTOP_WIDTH * zoom
  const height = DESKTOP_HEIGHT * zoom
  return {
    left: Math.max(0, rect.x + (rect.width - width) / 2),
    top: Math.max(0, rect.y + (rect.height - height) / 2),
    width: Math.max(1, width),
    height: Math.max(1, height),
    zoom,
  }
}

function scheduleLayout(): void {
  if (layoutFrame !== undefined || typeof window === 'undefined') return
  layoutFrame = window.requestAnimationFrame(() => {
    layoutFrame = undefined
    syncLayout()
  })
}

function syncLayout() {
  if (!native || stopped || (browserPanel.detached && !props.detached)) return
  layoutQueue = layoutQueue
    .catch(() => {})
    .then(async () => {
      const bounds = browserBounds()
      await invoke('browser_panel_layout', {
        payload: {
          visible: !stopped && visible.value && !!bounds,
          projectId: props.projectId,
          left: bounds?.left ?? 0,
          top: bounds?.top ?? 0,
          width: bounds?.width ?? 1,
          height: bounds?.height ?? 1,
          zoom: bounds?.zoom ?? 1,
        },
      })
    })
    .catch(error => {
      browserPanel.error = browserFailure(error)
    })
}

async function refresh() {
  if (!native || stopped || polling) return
  polling = true
  const projectId = props.projectId
  try {
    const status = await invoke<{ open: boolean; projectId?: string; url?: string }>('browser_panel_status')
    if (stopped || projectId !== props.projectId) return
    opened.value = status.open && status.projectId === projectId
    currentUrl.value = opened.value ? (status.url ?? '') : ''
    if (opened.value && activeTab.value.kind === 'browser') {
      activeTab.value.url = currentUrl.value
      if (activeTab.value.url) activeTab.value.title = new URL(activeTab.value.url).hostname || 'Browser'
    }
    if (document.activeElement?.id !== 'browser-address') address.value = currentUrl.value
    scheduleLayout()
  } catch (error) {
    browserPanel.error = browserFailure(error)
  } finally {
    polling = false
  }
}

async function navigate() {
  if (busy.value || !native) return
  if (activeTab.value.kind !== 'browser') return
  busy.value = true
  browserPanel.error = ''
  try {
    const target = browserNavigationUrl(address.value)
    const action = opened.value ? 'navigate' : 'open'
    activeTab.value.url = target
    await nextTick()
    syncLayout()
    await layoutQueue
    if (props.detached) {
      await requestPlaygroundAction({ type: 'browser', action, url: target })
    } else {
      const tool = browserTools.find(tool => tool.name === `browser_${action}`)!
      await tool.execute({ url: target }, browserContext())
    }
    opened.value = true
    currentUrl.value = target
    activeTab.value.url = target
    activeTab.value.title = new URL(target).hostname || 'Browser'
    browserSessionId =
      listToolSessions().find(
        item =>
          item.kind === 'browser' && item.projectId === props.projectId && item.conversationId === props.conversationId
      )?.id ?? browserSessionId
    await refresh()
  } catch (error) {
    browserPanel.error = browserFailure(error)
  } finally {
    busy.value = false
  }
}

async function closeSession() {
  busy.value = true
  try {
    if (props.detached) {
      await requestPlaygroundAction({ type: 'browser', action: 'close' })
      browserSessionId = ''
      opened.value = false
      activeTab.value.url = undefined
      currentUrl.value = ''
      return
    }
    const ownedSessionId =
      browserSessionId ||
      listToolSessions().find(
        item =>
          item.kind === 'browser' && item.projectId === props.projectId && item.conversationId === props.conversationId
      )?.id
    if (!ownedSessionId) throw new Error('Dieser Chat besitzt keine Browser-Sitzung, die hier beendet werden kann.')
    await closeToolSession(ownedSessionId)
    browserSessionId = ''
    opened.value = false
    activeTab.value.url = undefined
    currentUrl.value = ''
    await refresh()
  } catch (error) {
    browserPanel.error = browserFailure(error)
  } finally {
    busy.value = false
  }
}

function finishResize(): void {
  if (!resizing.value && !floatingResize.value) return
  resizing.value = false
  floatingResize.value = null
  window.removeEventListener('pointermove', resizePanel)
  window.removeEventListener('pointerup', finishResize)
  window.removeEventListener('pointercancel', finishResize)
}

function resizePanel(event: PointerEvent): void {
  if (floatingResize.value) {
    updateFloatingSize(
      floatingResize.value.width + event.clientX - floatingResize.value.pointerX,
      floatingResize.value.height + event.clientY - floatingResize.value.pointerY
    )
    scheduleLayout()
    return
  }
  clampHeight(resizeStartHeight + event.clientY - resizeStartY)
  scheduleLayout()
}

function startResize(event: PointerEvent): void {
  if (isFloating.value) {
    beginFloatingResize(event)
    return
  }
  if (event.button !== 0) return
  event.preventDefault()
  resizeStartY = event.clientY
  resizeStartHeight = panelHeight.value
  resizing.value = true
  window.addEventListener('pointermove', resizePanel)
  window.addEventListener('pointerup', finishResize)
  window.addEventListener('pointercancel', finishResize)
}

function resizeWithKeyboard(event: KeyboardEvent): void {
  const step = event.shiftKey ? 48 : 16
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    clampHeight(panelHeight.value - step)
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    clampHeight(panelHeight.value + step)
  } else if (event.key === 'Home') {
    event.preventDefault()
    clampHeight(MIN_HEIGHT)
  } else if (event.key === 'End') {
    event.preventDefault()
    clampHeight(maxHeight.value)
  } else {
    return
  }
  scheduleLayout()
}

function updateWindowHeight(): void {
  windowHeight.value = window.innerHeight
  windowWidth.value = window.innerWidth
  clampHeight(panelHeight.value)
  if (isFloating.value) updateFloatingSize(floatingSize.value.width, floatingSize.value.height)
  scheduleLayout()
}

function moveFloatingWindowByKeyboard(event: KeyboardEvent): void {
  if (!isFloating.value || !event.altKey) return
  const step = event.shiftKey ? 48 : 16
  const next = { ...floatingPoint.value }
  if (event.key === 'ArrowLeft') next.left -= step
  else if (event.key === 'ArrowRight') next.left += step
  else if (event.key === 'ArrowUp') next.top -= step
  else if (event.key === 'ArrowDown') next.top += step
  else return
  event.preventDefault()
  floatingPoint.value = {
    left: Math.max(0, Math.min(windowWidth.value - 220, next.left)),
    top: Math.max(0, Math.min(windowHeight.value - 100, next.top)),
  }
}

function resizeFloatingWithKeyboard(event: KeyboardEvent): void {
  if (!isFloating.value) return
  const step = event.shiftKey ? 48 : 16
  let width = floatingSize.value.width
  let height = floatingSize.value.height
  if (event.key === 'ArrowLeft') width -= step
  else if (event.key === 'ArrowRight') width += step
  else if (event.key === 'ArrowUp') height -= step
  else if (event.key === 'ArrowDown') height += step
  else return
  event.preventDefault()
  updateFloatingSize(width, height)
  scheduleLayout()
}

function collapse(): void {
  browserPanel.expanded = false
}

function activateTab(tab: ChatPlaygroundTab): void {
  playground.value.activeTabId = tab.id
  if (tab.kind === 'browser') {
    address.value = tab.url ?? ''
    if (tab.url && tab.url !== currentUrl.value) void navigate()
  }
}

watch(
  () => [props.projectId, props.conversationId],
  async ([projectId, conversationId], previous) => {
    if (previous && (projectId !== previous[0] || conversationId !== previous[1]) && browserSessionId) {
      await closeToolSession(browserSessionId).catch(() => false)
      browserSessionId = ''
    }
    opened.value = false
    currentUrl.value = ''
    address.value = activeTab.value.url ?? ''
  }
)

watch(
  [expanded, visible, () => props.projectId, () => props.conversationId, () => activeTab.value.id, panelHeight],
  async () => {
    await nextTick()
    scheduleLayout()
    void refresh()
  }
)
watch(isFloating, async () => {
  await nextTick()
  scheduleLayout()
})
onMounted(() => {
  resize = new ResizeObserver(scheduleLayout)
  if (viewport.value) resize.observe(viewport.value)
  mutations = new MutationObserver(() => {
    dialogOpen.value = !!document.querySelector('[aria-modal="true"]')
  })
  mutations.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-modal'],
  })
  window.addEventListener('resize', updateWindowHeight)
  document.addEventListener('visibilitychange', scheduleLayout)
  timer = setInterval(() => void refresh(), 750)
  void refresh()
})
onBeforeUnmount(() => {
  stopped = true
  finishFloatingDrag()
  finishResize()
  if (layoutFrame !== undefined) window.cancelAnimationFrame(layoutFrame)
  resize?.disconnect()
  mutations?.disconnect()
  clearInterval(timer)
  window.removeEventListener('resize', updateWindowHeight)
  document.removeEventListener('visibilitychange', scheduleLayout)
  if (native && (!browserPanel.detached || props.detached))
    void layoutQueue
      .finally(() =>
        invoke('browser_panel_layout', {
          payload: { visible: false, projectId: props.projectId, left: 0, top: 0, width: 1, height: 1, zoom: 1 },
        })
      )
      .catch(() => {})
})
</script>

<template>
  <Teleport to="body" :disabled="!isFloating">
    <section
      v-if="expanded"
      id="browser-panel"
      class="browser-panel"
      :class="{
        'is-resizing': resizing || !!floatingResize,
        'is-window': isFloating,
        'is-flush': !isFloating,
      }"
      :style="panelStyle"
      aria-label="Chat Playground"
    >
      <header class="browser-panel__header" @pointerdown="beginFloatingDrag" @keydown="moveFloatingWindowByKeyboard">
        <div class="browser-panel__identity">
          <small>CHAT PLAYGROUND</small>
          <strong>{{ activeTab.title }}</strong>
          <span>{{ projectName }} · {{ conversationId ? 'Chat' : 'Arbeitsbereich' }}</span>
        </div>
        <span class="browser-panel__state" :class="{ 'is-open': opened }">{{ opened ? 'Aktiv' : 'Bereit' }}</span>
        <button
          type="button"
          class="browser-panel__icon"
          :title="
            props.detached
              ? 'Chat Playground schließen'
              : native
                ? 'Als eigenständiges Fenster öffnen'
                : isFloating
                  ? 'An Chat andocken'
                  : 'Als verschiebbares Fenster öffnen'
          "
          :aria-label="
            props.detached
              ? 'Chat Playground schließen und zur Chatansicht zurückkehren'
              : native
                ? 'Chat Playground als eigenes Fenster öffnen'
                : isFloating
                  ? 'Chat Playground andocken'
                  : 'Chat Playground verschieben'
          "
          @pointerdown.stop
          @click="toggleViewMode"
        >
          <AiIcon :name="props.detached ? 'close' : isFloating ? 'panel' : 'grid'" :size="14" />
        </button>
        <button
          type="button"
          class="browser-panel__icon"
          title="Chat Playground einklappen"
          aria-label="Chat Playground einklappen"
          @pointerdown.stop
          @click="collapse"
        >
          <AiIcon name="chevron" :size="14" />
        </button>
      </header>

      <nav class="browser-panel__tabs" aria-label="Chat-Playground-Tabs">
        <div
          v-for="tab in playground.tabs"
          :key="tab.id"
          class="browser-panel__tab"
          :class="{ 'is-active': tab.id === activeTab.id }"
        >
          <button
            type="button"
            class="browser-panel__tab-select"
            :aria-current="tab.id === activeTab.id ? 'page' : undefined"
            @click="activateTab(tab)"
          >
            <AiIcon
              :name="
                tab.kind === 'files'
                  ? 'folder'
                  : tab.kind === 'terminal'
                    ? 'code'
                    : tab.kind === 'file'
                      ? 'edit'
                      : 'panel'
              "
              :size="13"
            />
            <span>{{ tab.title }}</span>
          </button>
          <button
            v-if="tab.kind !== 'files'"
            type="button"
            class="browser-panel__tab-close"
            :aria-label="`${tab.title} schließen`"
            title="Tab schließen"
            @click="removeTab(tab.id)"
          >
            <AiIcon name="close" :size="11" />
          </button>
        </div>
        <div class="browser-panel__add">
          <button
            type="button"
            class="browser-panel__add-button"
            :aria-expanded="showAddMenu"
            aria-haspopup="menu"
            aria-label="Tab hinzufügen"
            title="Tab hinzufügen"
            @click="showAddMenu = !showAddMenu"
          >
            <AiIcon name="plus" :size="14" />
          </button>
          <div v-if="showAddMenu" class="browser-panel__add-menu" role="menu">
            <button type="button" role="menuitem" @click="addBrowserTab">
              <AiIcon name="panel" :size="13" /> Browser-Tab
            </button>
            <button type="button" role="menuitem" @click="addTerminalTab">
              <AiIcon name="code" :size="13" /> Terminal-Tab
            </button>
          </div>
        </div>
      </nav>

      <p v-if="browserPanel.error" class="browser-panel__error" role="alert">{{ browserPanel.error }}</p>
      <main class="browser-panel__content">
        <ChatPlaygroundFiles
          v-if="activeTab.kind === 'files'"
          :project-id="projectId"
          :conversation-id="conversationId"
          :project-name="projectName"
          :workspace-name="workspaceName"
          :workspace-ready="workspaceReady"
          :mode="mode"
          :state="playground"
          :detached="detached"
          @open-file="openFile"
          @bind-folder="$emit('bindFolder')"
        />
        <ChatPlaygroundTerminal
          v-else-if="activeTab.kind === 'terminal'"
          :project-id="projectId"
          :conversation-id="conversationId"
          :workspace-name="workspaceName"
          :workspace-ready="workspaceReady"
          :mode="mode"
          :kill-switch="killSwitch"
          :detached="detached"
        />
        <article v-else-if="activeTab.kind === 'file'" class="browser-panel__file">
          <header>
            <span>{{ activeTab.path }}</span
            ><small>Vorschau · temporär</small>
          </header>
          <pre>{{ activeTab.content }}</pre>
        </article>
        <section v-else class="browser-panel__browser">
          <form class="browser-panel__address" @submit.prevent="navigate">
            <input
              id="browser-address"
              v-model="address"
              aria-label="Browser-Adresse"
              placeholder="Webadresse oder lokaler Dateipfad…"
              autocomplete="off"
              spellcheck="false"
              :disabled="!native || busy"
            />
            <button
              type="submit"
              :disabled="!native || busy || !address.trim()"
              :aria-label="busy ? 'Seite wird geladen' : 'Adresse öffnen'"
            >
              <AiIcon :name="busy ? 'clock' : 'arrow'" :size="14" />
            </button>
            <button
              v-if="opened"
              type="button"
              :disabled="busy"
              title="Browser-Sitzung beenden"
              aria-label="Browser-Sitzung beenden"
              @click="closeSession"
            >
              <AiIcon name="stop" :size="13" />
            </button>
          </form>
          <div class="browser-panel__stage">
            <div ref="viewport" class="browser-panel__viewport" aria-label="Browser-Arbeitsfläche">
              <div v-if="!opened" class="browser-panel__empty">
                <AiIcon name="panel" :size="24" />
                <strong>{{ native ? 'Browser bereit' : 'Browser in Luczor Desktop verfügbar' }}</strong>
                <p>
                  {{
                    native
                      ? 'Adresse eingeben oder den Browser über den Chat starten. Die Sitzung bleibt beim Einklappen erhalten.'
                      : 'Die Webvorschau benötigt die Luczor-Desktop-App.'
                  }}
                </p>
              </div>
              <div v-else-if="!visible" class="browser-panel__empty"><p>Browser vorübergehend ausgeblendet</p></div>
            </div>
          </div>
        </section>
      </main>
      <div
        class="browser-panel__resize"
        :class="{ 'is-window': isFloating }"
        role="separator"
        aria-orientation="horizontal"
        :aria-valuemin="isFloating ? 300 : MIN_HEIGHT"
        :aria-valuemax="isFloating ? windowHeight : maxHeight"
        :aria-valuenow="isFloating ? floatingSize.height : panelHeight"
        :aria-label="isFloating ? 'Fenstergröße anpassen' : 'Höhe des Chat Playgrounds anpassen'"
        tabindex="0"
        @pointerdown="startResize"
        @keydown="isFloating ? resizeFloatingWithKeyboard($event) : resizeWithKeyboard($event)"
      >
        <span aria-hidden="true" />
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.browser-panel {
  --playground-line: color-mix(in srgb, var(--ai-line) 88%, transparent);
  position: relative;
  z-index: 1;
  display: flex;
  width: 100%;
  height: var(--browser-workspace-height);
  min-height: 150px;
  flex: 0 0 auto;
  flex-direction: column;
  overflow: hidden;
  border-bottom: 1px solid var(--ai-line);
  background: var(--ai-page);
  color: var(--ai-ink);
  font-family: var(--ai-font);
}
.browser-panel.is-window {
  position: fixed;
  z-index: 75;
  top: var(--playground-top);
  left: var(--playground-left);
  width: var(--playground-width);
  height: var(--playground-height);
  min-width: 360px;
  min-height: 300px;
  margin: 0;
  border: 1px solid var(--ai-line-strong);
  border-radius: 10px;
  box-shadow: 0 18px 60px #0007;
}
.browser-panel.is-flush {
  margin: 0;
  border-top: 0;
  border-inline: 0;
  border-radius: 0;
  background: var(--ai-page);
  box-shadow: none;
}
.browser-panel__header {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  border-bottom: 1px solid var(--playground-line);
}
.browser-panel.is-window .browser-panel__header {
  cursor: grab;
  touch-action: none;
}
.browser-panel.is-window .browser-panel__header:active {
  cursor: grabbing;
}
.browser-panel__identity {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 1px;
}
.browser-panel__identity small {
  color: var(--ai-faint);
  font-size: 9px;
  letter-spacing: 0.12em;
}
.browser-panel__identity strong {
  overflow: hidden;
  color: var(--ai-ink);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-panel__identity span {
  overflow: hidden;
  color: var(--ai-faint);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-panel__state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ai-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.browser-panel__state::before {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ai-faint);
  content: '';
}
.browser-panel__state.is-open::before {
  background: var(--color-success, #73bf9d);
}
.browser-panel__icon,
.browser-panel__tab-close,
.browser-panel__add-button,
.browser-panel__address button {
  display: inline-grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ai-muted);
  cursor: pointer;
}
.browser-panel button:hover {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.browser-panel button:focus-visible,
.browser-panel input:focus-visible,
.browser-panel__resize:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 1px;
}
.browser-panel button:disabled {
  cursor: default;
  opacity: 0.45;
}
.browser-panel__tabs {
  position: relative;
  display: flex;
  min-height: 36px;
  flex: 0 0 auto;
  align-items: stretch;
  gap: 2px;
  padding: 0 10px;
  overflow-x: auto;
  border-bottom: 1px solid var(--playground-line);
  scrollbar-width: thin;
}
.browser-panel__tab {
  position: relative;
  display: flex;
  min-width: 0;
  max-width: 210px;
  flex: 0 1 auto;
  align-items: center;
  border-radius: 5px 5px 0 0;
}
.browser-panel__tab::after {
  position: absolute;
  right: 8px;
  bottom: -1px;
  left: 8px;
  height: 2px;
  background: transparent;
  content: '';
}
.browser-panel__tab.is-active {
  background: color-mix(in srgb, var(--ai-surface) 76%, transparent);
}
.browser-panel__tab.is-active::after {
  background: var(--ai-accent);
}
.browser-panel__tab-select {
  display: flex;
  min-width: 0;
  height: 31px;
  align-items: center;
  gap: 7px;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: var(--ai-muted);
  font: 11px var(--ai-font);
  cursor: pointer;
}
.browser-panel__tab-select span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-panel__tab.is-active .browser-panel__tab-select {
  color: var(--ai-ink);
}
.browser-panel__tab-close {
  width: 22px;
  height: 22px;
  margin-inline-end: 4px;
}
.browser-panel__add {
  position: sticky;
  right: 0;
  display: grid;
  flex: 0 0 32px;
  place-items: center;
  background: var(--ai-page);
}
.browser-panel__add-menu {
  position: absolute;
  z-index: 4;
  top: calc(100% + 4px);
  right: 0;
  display: grid;
  width: 190px;
  padding: 4px;
  border: 1px solid var(--ai-line-strong);
  border-radius: 8px;
  background: var(--ai-surface);
  box-shadow: 0 10px 28px #0005;
}
.browser-panel__add-menu button {
  display: flex;
  height: 32px;
  align-items: center;
  gap: 9px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ai-ink);
  text-align: left;
  font: 11px var(--ai-font);
  cursor: pointer;
}
.browser-panel__content {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
.browser-panel__browser {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
.browser-panel__address {
  display: flex;
  gap: 5px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--playground-line);
}
.browser-panel__address input {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  padding: 6px 9px;
  background: var(--ai-surface);
  color: var(--ai-ink);
  font: 11px var(--ai-font);
}
.browser-panel__stage {
  display: flex;
  min-height: 0;
  flex: 1;
  padding: 8px 10px;
}
.browser-panel.is-flush .browser-panel__stage {
  padding: 0;
}
.browser-panel__viewport {
  position: relative;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--ai-line);
  border-radius: 7px;
  background: var(--ai-inset, var(--ai-page));
}
.browser-panel.is-flush .browser-panel__viewport {
  border: 0;
  border-radius: 0;
}
.browser-panel__empty {
  display: grid;
  height: 100%;
  min-height: 74px;
  place-content: center;
  justify-items: center;
  gap: 6px;
  padding: 14px;
  color: var(--ai-muted);
  text-align: center;
}
.browser-panel__empty strong {
  color: var(--ai-ink);
  font-size: 12px;
  font-weight: 550;
}
.browser-panel__empty p {
  max-width: 440px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
}
.browser-panel__file {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
.browser-panel__file header {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid var(--playground-line);
  color: var(--ai-muted);
  font-size: 11px;
}
.browser-panel__file header span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browser-panel__file header small {
  flex: 0 0 auto;
  color: var(--ai-faint);
  font-size: 10px;
}
.browser-panel__file pre {
  min-height: 0;
  flex: 1;
  overflow: auto;
  margin: 0;
  padding: 14px;
  color: var(--ai-ink);
  font:
    11px/1.6 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
.browser-panel__error {
  margin: 0;
  padding: 5px 12px;
  border-bottom: 1px solid var(--ai-line);
  color: var(--ai-ink);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.browser-panel__resize {
  display: grid;
  height: 9px;
  flex: 0 0 9px;
  place-items: center;
  cursor: row-resize;
  touch-action: none;
}
.browser-panel__resize span {
  width: 34px;
  height: 2px;
  border-radius: 2px;
  background: var(--ai-line-strong);
}
.browser-panel__resize:hover span,
.browser-panel.is-resizing .browser-panel__resize span {
  background: var(--ai-accent);
}
.browser-panel__resize.is-window {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
}
.browser-panel__resize.is-window span {
  width: 7px;
  height: 7px;
  border-right: 1.5px solid var(--ai-muted);
  border-bottom: 1.5px solid var(--ai-muted);
  background: transparent;
}
.browser-panel.is-window .browser-panel__resize {
  align-self: flex-end;
  flex: 0 0 18px;
}
@media (max-width: 700px) {
  .browser-panel__header {
    padding-inline: 9px;
  }
  .browser-panel__state {
    display: none;
  }
  .browser-panel.is-window {
    right: 8px;
    left: 8px;
    width: auto;
    min-width: 0;
  }
}
</style>
