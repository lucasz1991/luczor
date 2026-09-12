<script setup lang="ts">
defineProps<{ label: string }>()
</script>

<template>
  <div class="chat-working" role="status" aria-live="polite">
    <span class="chat-working__orbit" aria-hidden="true"><i /><i /><i /></span>
    <span>{{ label }}</span>
  </div>
</template>

<style scoped>
.chat-working {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-height: 36px;
  margin: 4px 0 18px 44px;
  color: var(--ai-muted);
  font: 11px/1.4 var(--ai-font);
}
.chat-working__orbit {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  width: 26px;
}
.chat-working__orbit i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--ai-accent);
  animation: working-dot 1.1s ease-in-out infinite;
}
.chat-working__orbit i:nth-child(2) {
  animation-delay: 120ms;
}
.chat-working__orbit i:nth-child(3) {
  animation-delay: 240ms;
}
@keyframes working-dot {
  0%,
  100% {
    opacity: 0.3;
    transform: translateY(0);
  }
  45% {
    opacity: 1;
    transform: translateY(-3px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .chat-working__orbit i {
    animation: none;
  }
}
:global(html[data-reduce-motion='1']) .chat-working__orbit i {
  animation: none;
}
</style>
