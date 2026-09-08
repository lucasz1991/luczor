<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ReadAlongState } from '@/services/voice/readAlong'
import {
  createReadAloudHighlight,
  currentSpeechTextMatch,
  mapSpeechTextChunks,
  speechTextNodes,
} from '@/services/voice/readAloudHighlight'
import RichMessage from '../RichMessage.vue'

const props = defineProps<{ playback: ReadAlongState | null; content?: string }>()
const source = computed(() => props.content ?? props.playback?.text ?? '')
const body = ref<HTMLElement | null>(null)
const painter = createReadAloudHighlight()
let nodes: Text[] = []
let matches: ReturnType<typeof mapSpeechTextChunks> = []
const label = computed(() =>
  props.playback?.phase === 'playing'
    ? 'Wird vorgelesen'
    : props.playback?.phase === 'waiting'
      ? 'Wiedergabe wartet auf Audio'
      : 'Vorlesen wird vorbereitet'
)

function paint() {
  const playback = props.playback
  if (!playback || playback.phase !== 'playing' || !body.value) {
    painter.clear()
    return
  }
  const match = currentSpeechTextMatch(matches, playback.position)
  const node = match ? nodes[match.chunk] : null
  if (!match || !node?.isConnected) {
    painter.clear()
    return
  }
  const range = body.value.ownerDocument.createRange()
  range.setStart(node, match.offset)
  range.setEnd(node, match.offset + match.end - match.start)
  painter.show(range)
}

function mapContent() {
  if (!body.value) return
  nodes = speechTextNodes(body.value)
  matches = mapSpeechTextChunks(
    source.value,
    nodes.map(node => node.data)
  )
  paint()
}

onMounted(mapContent)
watch(source, mapContent, { flush: 'post' })
watch(() => props.playback, paint, { flush: 'post' })
onBeforeUnmount(() => painter.clear())
</script>

<template>
  <div class="read-aloud">
    <div v-if="playback" class="read-aloud__status" role="status">
      <span>{{ label }}</span>
      <span class="read-aloud__timing" title="Der Sprachdienst liefert keine exakten Wortzeitstempel.">
        Wortposition ungefähr
      </span>
    </div>
    <div ref="body" class="read-aloud__content">
      <slot><RichMessage :content="source" /></slot>
    </div>
  </div>
</template>

<style scoped>
.read-aloud__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  margin-block-end: 8px;
  font-size: 12px;
  color: var(--ai-accent, #a78bfa);
}
.read-aloud__timing {
  color: var(--ai-muted, #9ca3af);
  font-size: 11px;
}
</style>

<style>
::highlight(luczor-read-aloud) {
  background-color: #7762ab;
  background-color: color-mix(in srgb, var(--ai-accent, #a78bfa) 48%, transparent);
  text-decoration: underline;
  text-decoration-color: var(--ai-accent, #a78bfa);
}
</style>
