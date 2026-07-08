// src/composables/useAutoScroll.ts
import { nextTick, onMounted, watch, type Ref } from "vue";

const DEFAULT_THRESHOLD = 120;

export function useAutoScroll(
  items: Ref<{ id: string }[]>,
  options?: {
    selector?: string;
    thresholdPx?: number;
    behavior?: ScrollBehavior;
  }
) {
  const selector = options?.selector ?? "#messages";
  const threshold = options?.thresholdPx ?? DEFAULT_THRESHOLD;
  const behavior = options?.behavior ?? "smooth";

  function getScrollEl(): HTMLElement | null {
    return document.querySelector<HTMLElement>(selector);
  }

  function isNearBottom(el: HTMLElement) {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distance <= threshold;
  }

  function scrollToBottom(el: HTMLElement, mode: ScrollBehavior = behavior) {
    el.scrollTo({ top: el.scrollHeight, behavior: mode });
  }

  async function forceScroll(mode: ScrollBehavior = behavior) {
    await nextTick();
    const el = getScrollEl();
    if (el) scrollToBottom(el, mode);
  }

  // Initial scroll (z. B. beim Laden eines Projekts)
  onMounted(async () => {
    await nextTick();
    const el = getScrollEl();
    if (el) scrollToBottom(el, "auto");
  });

  // Reagiert nur auf neue IDs (keine Deep-Watch-Hölle)
  watch(
    () => items.value.map((i) => i.id).join(","),
    async () => {
      await nextTick();
      const el = getScrollEl();
      if (!el) return;
      if (!isNearBottom(el)) return;
      scrollToBottom(el);
    }
  );

  return {
    forceScroll,
  };
}
