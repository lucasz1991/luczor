<script setup lang="ts">
import { computed } from 'vue'
import { currentSpeechToken, speechTokens, type ReadAlongState } from '@/services/voice/readAlong'

const props = defineProps<{ playback: ReadAlongState }>()
const tokens = computed(() => speechTokens(props.playback.text))
const current = computed(() =>
  props.playback.phase === 'playing' ? currentSpeechToken(tokens.value, props.playback.position) : -1
)
const label = computed(() =>
  props.playback.phase === 'playing'
    ? 'Wird vorgelesen'
    : props.playback.phase === 'waiting'
      ? 'Wiedergabe wartet auf Audio'
      : 'Vorlesen wird vorbereitet'
)
</script>

<template>
  <div class="read-aloud">
    <div class="read-aloud__status" role="status">
      <span>{{ label }}</span>
      <span class="read-aloud__timing" title="Der Sprachdienst liefert keine exakten Wortzeitstempel.">
        Wortposition ungefähr
      </span>
    </div>
    <p class="read-aloud__text">
      <template v-for="(token, index) in tokens" :key="token.start"
        ><mark v-if="index === current" class="read-aloud__current" aria-current="true">{{ token.text }}</mark
        ><span v-else :class="{ 'read-aloud__read': token.end <= playback.position }">{{ token.text }}</span></template
      >
    </p>
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
.read-aloud__text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.75;
}
.read-aloud__current {
  color: var(--ai-ink, #f9fafb);
  background: color-mix(in srgb, var(--ai-accent, #a78bfa) 38%, transparent);
  border-radius: 4px;
  box-shadow: 0 2px 0 var(--ai-accent, #a78bfa);
  padding-block: 2px;
}
.read-aloud__read {
  color: var(--ai-muted, #b9b9c5);
}
</style>
