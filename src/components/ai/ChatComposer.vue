<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import AiIcon from './AiIcon.vue'
const props = withDefaults(
  defineProps<{
    tabs?: { id: string; label: string }[]
    title?: string
    scrollId?: string
    follow?: boolean
    flushWorkspace?: boolean
  }>(),
  {
    tabs: () => [],
    title: 'Chat',
    scrollId: undefined,
    follow: true,
  }
)
const activeTab = defineModel<string>('activeTab', { default: '' })
const scroller = ref<HTMLElement | null>(null)
const thread = ref<HTMLElement | null>(null)
const generatedId = useId()
const atBottom = ref(true)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(() => {
    if (!props.follow && scroller.value) scroller.value.scrollTop = 0
    else if (atBottom.value && scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
  if (thread.value) observer.observe(thread.value)
})
onBeforeUnmount(() => observer?.disconnect())
watch(
  () => props.follow,
  follow => {
    if (!follow && scroller.value) {
      scroller.value.scrollTop = 0
      atBottom.value = true
    }
  },
  { flush: 'post' }
)
function measure() {
  const el = scroller.value
  if (el) atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120
}
function scrollToBottom() {
  const reducedMotion =
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    !!scroller.value?.closest('[data-reduce-motion="1"], [data-reduce-motion="true"]')
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: reducedMotion ? 'auto' : 'smooth' })
}
defineExpose({ scrollToBottom })
</script>
<template>
  <section
    class="ai-chat"
    :class="{ 'ai-chat--with-overlay': !!$slots.overlay, 'ai-chat--with-workspace': !!$slots.workspace }"
    :aria-label="title || 'Chat'"
  >
    <header v-if="tabs.length" class="ai-chat__tabs">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        :aria-pressed="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </header>
    <slot name="overlay" />
    <div
      v-if="$slots.workspace"
      class="ai-chat__workspace"
      :class="{ 'is-flush': flushWorkspace }"
      :style="flushWorkspace ? { paddingTop: '0px' } : undefined"
    >
      <slot name="workspace" />
    </div>
    <div :id="scrollId || generatedId" ref="scroller" class="ai-chat__messages" @scroll.passive="measure">
      <div ref="thread" class="ai-thread"><slot /></div>
    </div>
    <button v-if="follow && !atBottom" class="ai-jump ai-button" type="button" @click="scrollToBottom">
      <AiIcon name="arrow" :size="14" class="ai-jump__arrow" />
      Zur neuesten Nachricht
    </button>
    <div v-if="$slots.composer" class="ai-chat__composer"><slot name="composer" /></div>
  </section>
</template>

<style scoped>
.ai-chat {
  position: relative;
  min-height: 0;
}
.ai-chat--with-overlay > .ai-chat__messages {
  padding-block-start: 72px;
  scroll-padding-block-start: 72px;
}
.ai-chat__workspace {
  position: relative;
  z-index: 1;
  min-height: 0;
  flex: 0 0 auto;
  padding-top: 48px;
}
.ai-chat__workspace.is-flush {
  padding-top: 0;
}
.ai-chat--with-overlay.ai-chat--with-workspace > .ai-chat__messages {
  padding-block-start: 24px;
  scroll-padding-block-start: 24px;
}
.ai-chat__messages {
  overscroll-behavior-y: contain;
  scrollbar-gutter: stable;
}
.ai-jump {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  min-height: 36px;
  box-shadow: 0 4px 16px #0002;
}
.ai-jump__arrow {
  transform: rotate(90deg);
}
</style>
