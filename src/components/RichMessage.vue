<!-- components/RichMessage.vue
     Renders assistant chat output as styled HTML (lists, tables, code,
     quotes, headings) instead of flat text.

     SECURITY: the HTML comes exclusively from `renderRichText`, which escapes
     its input FIRST and only then emits tags. Model output can therefore not
     inject markup, so `v-html` is safe HERE and only here. Never point this
     component at a string that has not gone through renderRichText().

     Links are rendered by the renderer WITHOUT an href (data-href instead), so
     the WebView can never navigate away from the app shell. This component
     intercepts the click and hands the URL to the `open_url` Tauri command,
     which enforces http(s) natively. -->
<script setup lang="ts">
import { computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { renderRichText } from '@/services/richText'

const props = defineProps<{
  /** Raw markdown-ish assistant text. */
  content: string
  /** Show a blinking caret while the answer is still streaming. */
  streaming?: boolean
}>()

const html = computed(() => renderRichText(props.content ?? ''))

function resolveHref(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const anchor = target.closest('[data-href]')
  const href = anchor?.getAttribute('data-href')?.trim()
  return href ? href : null
}

/** Open a link in the OS browser instead of navigating the WebView. */
function openExternal(url: string) {
  void invoke('open_url', { payload: { url } }).catch(error => {
    console.warn('[richMessage] open_url failed:', error)
  })
}

function onClick(event: MouseEvent) {
  const url = resolveHref(event.target)
  if (!url) return
  event.preventDefault()
  openExternal(url)
}

/** The renderer emits role="link" + tabindex="0", so keyboard must work too. */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const url = resolveHref(event.target)
  if (!url) return
  event.preventDefault()
  openExternal(url)
}
</script>

<template>
  <div class="rt" @click="onClick" @keydown="onKeydown">
    <!-- eslint-disable-next-line vue/no-v-html -- see security note above -->
    <span v-html="html" />
    <span v-if="streaming" class="rt-caret" />
  </div>
</template>

<style scoped>
/* Scoped CSS does NOT reach v-html children, hence :deep() everywhere. */
.rt {
  font-size: 14.5px;
  line-height: 1.62;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

/* ---------- blocks ---------- */
.rt :deep(.rt-p) {
  margin: 0 0 0.68em;
}
.rt :deep(.rt-p:last-child) {
  margin-bottom: 0;
}

.rt :deep(.rt-h) {
  margin: 1.05em 0 0.45em;
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: 0.01em;
  color: var(--text-primary);
}
.rt :deep(.rt-h:first-child) {
  margin-top: 0;
}
.rt :deep(h3.rt-h) {
  font-size: 1.16em;
}
.rt :deep(h4.rt-h) {
  font-size: 1.06em;
}
.rt :deep(h5.rt-h) {
  font-size: 0.95em;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.rt :deep(.rt-hr) {
  margin: 1.1em 0;
  border: 0;
  border-top: 1px solid var(--border-soft);
}

/* ---------- lists ---------- */
.rt :deep(.rt-list) {
  margin: 0 0 0.7em;
  padding-left: 1.35em;
}
.rt :deep(.rt-list:last-child) {
  margin-bottom: 0;
}
.rt :deep(.rt-list .rt-list) {
  margin: 0.3em 0 0.15em;
}
.rt :deep(.rt-li) {
  margin: 0.22em 0;
  padding-left: 0.12em;
}
.rt :deep(ul.rt-list) {
  list-style: none;
  padding-left: 1.1em;
}
.rt :deep(ul.rt-list > .rt-li) {
  position: relative;
}
.rt :deep(ul.rt-list > .rt-li)::before {
  content: '';
  position: absolute;
  left: -0.9em;
  top: 0.62em;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--cy, currentColor);
  opacity: 0.75;
}
.rt :deep(ol.rt-list) {
  list-style: decimal;
}
.rt :deep(ol.rt-list > .rt-li)::marker {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

/* ---------- quote ---------- */
.rt :deep(.rt-quote) {
  margin: 0 0 0.75em;
  padding: 0.1em 0 0.1em 0.9em;
  border-left: 2px solid var(--cy, var(--border-soft));
  color: var(--text-muted);
}
.rt :deep(.rt-quote:last-child) {
  margin-bottom: 0;
}

/* ---------- code ---------- */
.rt :deep(.rt-code-inline) {
  padding: 0.1em 0.36em;
  border: 1px solid var(--border-soft);
  border-radius: 5px;
  background: rgba(127, 127, 127, 0.13);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.88em;
  white-space: break-spaces;
}
.rt :deep(.rt-code) {
  position: relative;
  margin: 0.55em 0 0.8em;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md, 10px);
  background: rgba(10, 14, 20, 0.42);
  overflow: hidden;
}
.rt :deep(.rt-code:last-child) {
  margin-bottom: 0;
}
.rt :deep(.rt-code__pre) {
  margin: 0;
  padding: 0.72em 0.85em;
  overflow-x: auto;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.86em;
  line-height: 1.55;
  tab-size: 2;
}
.rt :deep(.rt-code__pre code) {
  font: inherit;
  color: inherit;
  white-space: pre;
}
.rt :deep(.rt-code__lang) {
  position: absolute;
  top: 0.32em;
  right: 0.5em;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  pointer-events: none;
}

/* ---------- table ---------- */
.rt :deep(.rt-table-wrap) {
  margin: 0.55em 0 0.8em;
  overflow-x: auto;
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md, 10px);
}
.rt :deep(.rt-table-wrap:last-child) {
  margin-bottom: 0;
}
.rt :deep(.rt-table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9em;
}
.rt :deep(.rt-table th),
.rt :deep(.rt-table td) {
  padding: 0.44em 0.7em;
  text-align: left;
  border-bottom: 1px solid var(--border-soft);
  vertical-align: top;
}
.rt :deep(.rt-table thead th) {
  background: rgba(127, 127, 127, 0.11);
  font-weight: 620;
  font-size: 0.94em;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.rt :deep(.rt-table tbody tr:last-child td) {
  border-bottom: 0;
}
.rt :deep(.rt-table tbody tr:hover td) {
  background: rgba(127, 127, 127, 0.06);
}

/* ---------- inline ---------- */
.rt :deep(strong) {
  font-weight: 650;
  color: var(--text-primary);
}
.rt :deep(em) {
  font-style: italic;
}
.rt :deep(s) {
  opacity: 0.62;
}
.rt :deep(.rt-link) {
  color: var(--cy, #4ea8de);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
  cursor: pointer;
}
.rt :deep(.rt-link:hover) {
  text-decoration-thickness: 2px;
}
.rt :deep(.rt-link:focus-visible) {
  outline: 2px solid var(--cy, #4ea8de);
  outline-offset: 2px;
  border-radius: 3px;
}

/* ---------- streaming caret ---------- */
.rt-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--cy, currentColor);
  animation: rt-blink 1s steps(2, start) infinite;
}
@keyframes rt-blink {
  50% {
    opacity: 0;
  }
}
</style>
