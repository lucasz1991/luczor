<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke, isTauri } from '@tauri-apps/api/core'
import AiIcon from '@/components/ai/AiIcon.vue'
import { browserFailure, browserPanel } from '@/services/browserPanel'
import { browserTools } from '@/services/tools/browser'

const props = defineProps<{ projectId: string; suspended?: boolean }>()
const viewport = ref<HTMLElement | null>(null)
const address = ref('')
const currentUrl = ref('')
const opened = ref(false)
const busy = ref(false)
const dialogOpen = ref(false)
const native = typeof window !== 'undefined' && isTauri()
const expanded = computed(() => browserPanel.expanded)
const visible = computed(
  () => expanded.value && !props.suspended && !dialogOpen.value && (typeof document === 'undefined' || !document.hidden)
)
let resize: ResizeObserver | undefined
let mutations: MutationObserver | undefined
let timer: ReturnType<typeof setInterval> | undefined
let stopped = false
let polling = false
let layoutQueue = Promise.resolve()

function syncLayout() {
  if (!native || stopped) return
  layoutQueue = layoutQueue
    .catch(() => {})
    .then(async () => {
      const rect = viewport.value?.getBoundingClientRect()
      await invoke('browser_panel_layout', {
        payload: {
          visible: !stopped && visible.value && !!rect && rect.width > 20 && rect.height > 20,
          projectId: props.projectId,
          left: Math.max(0, rect?.x ?? 0),
          top: Math.max(0, rect?.y ?? 0),
          width: Math.max(1, rect?.width ?? 1),
          height: Math.max(1, rect?.height ?? 1),
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
    const status = await invoke<{ open: boolean; projectId?: string; url?: string; busy?: boolean }>(
      'browser_panel_status'
    )
    if (stopped || projectId !== props.projectId) return
    opened.value = status.open && status.projectId === projectId
    currentUrl.value = opened.value ? (status.url ?? '') : ''
    if (document.activeElement?.id !== 'browser-address') address.value = currentUrl.value
    syncLayout()
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

watch([expanded, visible, () => props.projectId], async () => {
  await nextTick()
  syncLayout()
  void refresh()
})
onMounted(() => {
  resize = new ResizeObserver(syncLayout)
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
  window.addEventListener('resize', syncLayout)
  document.addEventListener('visibilitychange', syncLayout)
  timer = setInterval(() => void refresh(), 750)
  void refresh()
})
onBeforeUnmount(() => {
  stopped = true
  resize?.disconnect()
  mutations?.disconnect()
  clearInterval(timer)
  window.removeEventListener('resize', syncLayout)
  document.removeEventListener('visibilitychange', syncLayout)
  if (native)
    void layoutQueue
      .finally(() =>
        invoke('browser_panel_layout', {
          payload: { visible: false, projectId: props.projectId, left: 0, top: 0, width: 1, height: 1 },
        })
      )
      .catch(() => {})
})
</script>

<template>
  <aside id="browser-panel" class="browser-panel" :class="{ 'is-collapsed': !expanded }" aria-label="Interner Browser">
    <button
      v-if="!expanded"
      class="browser-panel__restore"
      type="button"
      title="Browser ausklappen"
      aria-label="Browser ausklappen"
      aria-expanded="false"
      @click="browserPanel.expanded = true"
    >
      <AiIcon name="panel" :size="18" /><span>Browser</span><span v-if="opened" class="browser-panel__dot" />
    </button>
    <div v-show="expanded" class="browser-panel__body">
      <header class="browser-panel__header">
        <div>
          <strong>Browser</strong><span>{{ opened ? 'Mit dem Chat verbunden' : 'Neben dem Chat arbeiten' }}</span>
        </div>
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
          title="Browser einklappen · Sitzung behalten"
          aria-label="Browser einklappen"
          aria-expanded="true"
          @click="browserPanel.expanded = false"
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
      <div ref="viewport" class="browser-panel__viewport">
        <div v-if="!opened" class="browser-panel__empty">
          <AiIcon name="panel" :size="30" />
          <h2>Chat links. Webseite rechts.</h2>
          <p>
            {{
              native
                ? 'Öffne eine Adresse oder beauftrage Luczor im Chat. Einklappen erhält deine Browser-Sitzung.'
                : 'Der interne Browser steht in der Luczor-Desktop-App zur Verfügung.'
            }}
          </p>
        </div>
        <div v-else-if="!visible" class="browser-panel__empty"><p>Browser vorübergehend ausgeblendet</p></div>
      </div>
      <footer>
        {{ opened ? 'Interne Browser-Sitzung' : 'Interner Browser'
        }}<span>{{ busy ? 'Lädt …' : opened ? 'Aktiv' : 'Bereit' }}</span>
      </footer>
    </div>
  </aside>
</template>

<style scoped>
.browser-panel {
  min-width: 0;
  min-height: 0;
  height: 100%;
  border-left: 1px solid var(--ai-line);
  background: var(--ai-page);
  color: var(--ai-ink);
  font-family: var(--ai-font);
}
.browser-panel__body {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.browser-panel__header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 72px;
  padding: 12px 16px;
}
.browser-panel__header > div {
  flex: 1;
  display: grid;
  gap: 4px;
}
.browser-panel__header strong {
  font-size: 14px;
  font-weight: 600;
}
.browser-panel__header span,
footer {
  font-size: 11px;
  color: var(--ai-muted);
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  width: 32px;
  height: 32px;
  background: transparent;
  color: var(--ai-muted);
  cursor: pointer;
}
button:hover {
  background: var(--ai-surface);
  color: var(--ai-ink);
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 2px;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.browser-panel__address {
  display: flex;
  gap: 6px;
  padding: 0 12px 12px;
}
input {
  min-width: 0;
  width: 100%;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  background: var(--ai-surface);
  color: var(--ai-ink);
  padding: 8px 10px;
  font: 12px var(--ai-font);
}
.browser-panel__viewport {
  flex: 1;
  min-height: 80px;
  overflow: hidden;
  border-top: 1px solid var(--ai-line);
  position: relative;
}
.browser-panel__empty {
  display: flex;
  height: 100%;
  min-height: 160px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  color: var(--ai-muted);
}
h2 {
  color: var(--ai-ink);
  font-size: 16px;
  font-weight: 500;
  margin: 18px 0 8px;
}
p {
  font-size: 12px;
  line-height: 1.6;
  max-width: 290px;
  margin: 0;
}
.browser-panel__error {
  max-width: none;
  padding: 10px 16px;
  color: var(--ai-ink);
  border-top: 1px solid var(--ai-line);
  overflow-wrap: anywhere;
}
footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--ai-line);
}
.browser-panel__restore {
  width: 100%;
  height: auto;
  padding: 24px 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-radius: 0;
}
.browser-panel__restore span:not(.browser-panel__dot) {
  writing-mode: vertical-rl;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.browser-panel__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--ai-accent);
}
</style>
