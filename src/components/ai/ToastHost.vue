<script setup lang="ts">
import { toastState, dismissToast, type ToastKind } from '@/services/toast'
import AiIcon from './AiIcon.vue'

const ICONS: Record<ToastKind, string> = { success: 'check', error: 'close', info: 'spark' }
</script>

<template>
  <div class="app-toasts" aria-label="Meldungen">
    <TransitionGroup name="app-toast" tag="div" class="app-toasts__stack">
      <div v-for="toast in toastState.items" :key="toast.id" class="app-toast" :data-kind="toast.kind" role="status">
        <span class="app-toast__icon"><AiIcon :name="ICONS[toast.kind]" :size="14" /></span>
        <p class="app-toast__message">{{ toast.message }}</p>
        <button type="button" class="app-toast__close" aria-label="Meldung schließen" @click="dismissToast(toast.id)">
          <AiIcon name="close" :size="11" />
        </button>
        <span
          v-if="toast.duration > 0"
          class="app-toast__bar"
          :style="{ animationDuration: `${toast.duration}ms` }"
        />
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.app-toasts {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2000;
  pointer-events: none;
  display: flex;
  justify-content: flex-end;
}
.app-toasts__stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(360px, calc(100vw - 32px));
}
.app-toast {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: start;
  gap: 9px;
  padding: 11px 12px 13px;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid var(--ai-line-strong, rgba(255, 255, 255, 0.12));
  background: var(--ai-surface, #16161c);
  box-shadow: 0 18px 40px -18px rgba(0, 0, 0, 0.55);
  color: var(--ai-ink, #edece6);
  font: 12.5px/1.5 var(--ai-font, inherit);
  pointer-events: auto;
}
.app-toast__icon {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  flex-shrink: 0;
  color: var(--ai-accent, #a78bfa);
  background: color-mix(in srgb, var(--ai-accent, #a78bfa) 16%, transparent);
}
.app-toast[data-kind='success'] .app-toast__icon {
  color: var(--ai-green, #6cb98a);
  background: color-mix(in srgb, var(--ai-green, #6cb98a) 16%, transparent);
}
.app-toast[data-kind='error'] .app-toast__icon {
  color: var(--ai-red, #e06c75);
  background: color-mix(in srgb, var(--ai-red, #e06c75) 16%, transparent);
}
.app-toast__message {
  margin: 3px 0 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--ai-ink, #edece6);
}
.app-toast__close {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ai-muted, #9a9a9a);
  cursor: pointer;
}
.app-toast__close:hover {
  color: var(--ai-ink, #edece6);
  background: var(--ai-hover, rgba(255, 255, 255, 0.06));
}
.app-toast__bar {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  background: var(--ai-accent, #a78bfa);
  transform-origin: left;
  animation: app-toast-shrink linear forwards;
}
.app-toast[data-kind='success'] .app-toast__bar {
  background: var(--ai-green, #6cb98a);
}
.app-toast[data-kind='error'] .app-toast__bar {
  background: var(--ai-red, #e06c75);
}
@keyframes app-toast-shrink {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}
.app-toast-move,
.app-toast-enter-active,
.app-toast-leave-active {
  transition:
    transform 260ms var(--ease, cubic-bezier(0.32, 0.72, 0, 1)),
    opacity 220ms ease;
}
.app-toast-enter-from {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}
.app-toast-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
.app-toast-leave-active {
  position: absolute;
  right: 0;
  width: min(360px, calc(100vw - 32px));
}
@media (prefers-reduced-motion: reduce) {
  .app-toast__bar {
    animation: none;
  }
  .app-toast-move,
  .app-toast-enter-active,
  .app-toast-leave-active {
    transition: none;
  }
}
</style>
