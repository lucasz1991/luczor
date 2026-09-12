<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import AiIcon from '@/components/ai/AiIcon.vue'
import { browserFailure, browserPanel } from '@/services/browserPanel'
import { browserTools } from '@/services/tools/browser'

const DESKTOP_WIDTH = 1600
const DESKTOP_HEIGHT = 900
const MIN_HEIGHT = 150
const DEFAULT_HEIGHT = 360

const props = defineProps<{ projectId: string; suspended?: boolean }>()
const viewport = ref<HTMLElement | null>(null)
const address = ref('')
const currentUrl = ref('')
const opened = ref(false)
const busy = ref(false)
const dialogOpen = ref(false)
const panelHeight = ref(DEFAULT_HEIGHT)
const windowHeight = ref(typeof window === 'undefined' ? 900 : window.innerHeight)
const resizing = ref(false)
const native = typeof window !== 'undefined' && isTauri()
const expanded = computed(() => browserPanel.expanded)
const maxHeight = computed(() => Math.max(MIN_HEIGHT, Math.min(760, Math.round(windowHeight.value * 0.64))))
const visible = computed(
  () => expanded.value && !props.suspended && !dialogOpen.value && (typeof document === 'undefined' || !document.hidden)
)
const panelStyle = computed(() => ({
  '--browser-workspace-height': `${Math.min(panelHeight.value, maxHeight.value)}px`,
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

type BrowserBounds = { left: number; top: number; width: number; height: number; zoom: number }

function clampHeight(next: number): void {
  panelHeight.value = Math.min(maxHeight.value, Math.max(MIN_HEIGHT, Math.round(next)))
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
  if (!native || stopped) return
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
  busy.value = true
  browserPanel.error = ''
  try {
    const target = new URL(address.value.includes('://') ? address.value : `https://${address.value}`)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new Error('Bitte eine HTTP(S)-Adresse ohne Zugangsdaten eingeben.')
    const tool = browserTools.find(tool => tool.name === (opened.value ? 'browser_navigate' : 'browser_open'))!
    await tool.execute(opened.value ? { url: target.href } : { url: target.href, allowed_hosts: [target.host] }, {
      projectId: props.projectId,
    })
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
    await browserTools.find(tool => tool.name === 'browser_close')!.execute({}, { projectId: props.projectId })
    opened.value = false
    address.value = currentUrl.value = ''
  } catch (error) {
    browserPanel.error = browserFailure(error)
  } finally {
    busy.value = false
  }
}

function finishResize(): void {
  if (!resizing.value) return
  resizing.value = false
  window.removeEventListener('pointermove', resizePanel)
  window.removeEventListener('pointerup', finishResize)
  window.removeEventListener('pointercancel', finishResize)
}

function resizePanel(event: PointerEvent): void {
  clampHeight(resizeStartHeight + event.clientY - resizeStartY)
  scheduleLayout()
}

function startResize(event: PointerEvent): void {
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
  clampHeight(panelHeight.value)
  scheduleLayout()
}

function collapse(): void {
  browserPanel.expanded = false
}

watch([expanded, visible, () => props.projectId, panelHeight], async () => {
  await nextTick()
  scheduleLayout()
  void refresh()
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
  finishResize()
  if (layoutFrame !== undefined) window.cancelAnimationFrame(layoutFrame)
  resize?.disconnect()
  mutations?.disconnect()
  clearInterval(timer)
  window.removeEventListener('resize', updateWindowHeight)
  document.removeEventListener('visibilitychange', scheduleLayout)
  if (native)
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
  <section
    v-if="expanded"
    id="browser-panel"
    class="browser-panel"
    :class="{ 'is-resizing': resizing }"
    :style="panelStyle"
    aria-label="Interner Browser"
  >
    <header class="browser-panel__header">
      <div>
        <span>Interner Browser</span>
        <strong>Desktop-Ansicht <code>1600 × 900</code></strong>
      </div>
      <span class="browser-panel__state" :class="{ 'is-open': opened }">{{ opened ? 'Aktiv' : 'Bereit' }}</span>
      <button
        v-if="opened"
        type="button"
        :disabled="busy"
        title="Browser-Sitzung beenden"
        aria-label="Browser-Sitzung beenden"
        @click="closeSession"
      >
        <AiIcon name="close" />
      </button>
      <button
        type="button"
        title="Browser vollständig einklappen · Sitzung behalten"
        aria-label="Browser vollständig einklappen"
        aria-expanded="true"
        @click="collapse"
      >
        <AiIcon name="chevron" />
      </button>
    </header>
    <form class="browser-panel__address" @submit.prevent="navigate">
      <input
        id="browser-address"
        v-model="address"
        aria-label="Browser-Adresse"
        placeholder="https://…"
        autocomplete="off"
        spellcheck="false"
        :disabled="!native || busy"
      />
      <button
        type="submit"
        :disabled="!native || busy || !address.trim()"
        :aria-label="busy ? 'Seite wird geladen' : 'Adresse öffnen'"
      >
        <AiIcon :name="busy ? 'clock' : 'arrow'" />
      </button>
    </form>
    <p v-if="browserPanel.error" class="browser-panel__error" role="alert">{{ browserPanel.error }}</p>
    <div class="browser-panel__stage">
      <div ref="viewport" class="browser-panel__viewport" aria-label="Browser-Desktop mit 1600 mal 900 Pixeln">
        <div v-if="!opened" class="browser-panel__empty">
          <AiIcon name="panel" :size="26" />
          <strong>Browser als Desktop-Arbeitsfläche</strong>
          <p>
            {{
              native
                ? 'Öffne eine Adresse oder beauftrage Luczor im Chat. Die Sitzung bleibt beim Einklappen erhalten.'
                : 'Der interne Browser steht in der Luczor-Desktop-App zur Verfügung.'
            }}
          </p>
        </div>
        <div v-else-if="!visible" class="browser-panel__empty"><p>Browser vorübergehend ausgeblendet</p></div>
      </div>
    </div>
    <div
      class="browser-panel__resize"
      role="separator"
      aria-orientation="horizontal"
      :aria-valuemin="MIN_HEIGHT"
      :aria-valuemax="maxHeight"
      :aria-valuenow="panelHeight"
      aria-label="Browser-Höhe anpassen"
      tabindex="0"
      @pointerdown="startResize"
      @keydown="resizeWithKeyboard"
    >
      <span aria-hidden="true" />
    </div>
  </section>
</template>

<style scoped>
.browser-panel {
  display: flex;
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
.browser-panel__header {
  display: flex;
  min-height: 40px;
  align-items: center;
  gap: 8px;
  padding: 5px 18px 4px;
}
.browser-panel__header > div {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 1px;
}
.browser-panel__header span {
  color: var(--ai-faint);
  font-size: 10px;
}
.browser-panel__header strong {
  color: var(--ai-ink);
  font-size: 12px;
  font-weight: 600;
}
.browser-panel__header code {
  margin-inline-start: 4px;
  color: var(--ai-muted);
  font: 10px var(--ai-font);
}
.browser-panel__state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
button {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ai-muted);
  cursor: pointer;
}
button:hover {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
button:focus-visible,
input:focus-visible,
.browser-panel__resize:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 2px;
}
button:disabled {
  cursor: default;
  opacity: 0.45;
}
.browser-panel__address {
  display: flex;
  gap: 6px;
  padding: 0 18px 6px;
}
input {
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
  padding: 0 18px 7px;
}
.browser-panel__viewport {
  position: relative;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--ai-line);
  border-radius: 8px;
  background:
    linear-gradient(45deg, color-mix(in srgb, var(--ai-inset) 88%, transparent) 25%, transparent 25%) 0 0 / 14px 14px,
    linear-gradient(-45deg, color-mix(in srgb, var(--ai-inset) 88%, transparent) 25%, transparent 25%) 0 0 / 14px 14px,
    var(--ai-page);
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
.browser-panel__error {
  margin: 0;
  padding: 5px 18px;
  border-top: 1px solid var(--ai-line);
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
@media (max-width: 700px) {
  .browser-panel__header,
  .browser-panel__address,
  .browser-panel__stage {
    padding-inline: 10px;
  }
  .browser-panel__header strong code {
    display: none;
  }
}
</style>
