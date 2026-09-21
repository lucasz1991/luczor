<script setup lang="ts">
withDefaults(defineProps<{ name?: string; size?: number }>(), { name: 'spark', size: 16 })
const paths: Record<string, string> = {
  spark: 'M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
  chevron: 'm9 5 7 7-7 7',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6',
  plus: 'M12 5v14M5 12h14',
  send: 'M12 20V4m-6 6 6-6 6 6',
  stop: 'M6 6h12v12H6Z',
  search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  copy: 'M8 8h12v12H8ZM16 8V4H4v12h4',
  folder: 'M3 6h7l2 3h9v11H3Z',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
  mic: 'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0ZM5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8',
  sound: 'm11 5-6 4H2v6h3l6 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  tool: 'M14 6a5 5 0 0 0-6 6L2 18l4 4 6-6a5 5 0 0 0 6-6l-4 1-3-3Z',
  panel: 'M3 4h18v16H3ZM8 4v16',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  arrow: 'M4 12h16m-5-5 5 5-5 5',
  clock: 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  shield: 'm12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5Zm-4 9 3 3 5-5',
  grid: 'M3 3h7v7H3Zm11 0h7v7h-7ZM3 14h7v7H3Zm11 0h7v7h-7Z',
  chat: 'M4 5h16v11H9l-5 4Z',
  link: 'M4 8.5a12 12 0 0 1 16 0M7 12a7 7 0 0 1 10 0M10 15.5a2.5 2.5 0 0 1 4 0',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 20h16',
  'thumb-up': 'M7 10v11H3V10Zm0 1 5-8c3 0 2 5 2 7h5c2 0 2 1 2 2l-2 7c0 1-1 2-2 2H7',
  'thumb-down': 'M7 14V3H3v11Zm0-1 5 8c3 0 2-5 2-7h5c2 0 2-1 2-2l-2-7c0-1-1-2-2-2H7',
  gauge: 'M3 17l5-7 4 4 4-8 5 9',
  trash: 'M4 7h16M9 7V4h6v3m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v6m4-6v6',
}
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.spark" />
  </svg>
</template>
