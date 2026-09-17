// src/services/toast.ts
//
// Lightweight in-app notifications for one-off status messages ("Voice-Einstellungen
// gespeichert.", a failed read-aloud, …) that used to sit as a dismiss-it-yourself bar above the
// composer. Rendered by <ToastHost /> as small auto-dismissing cards, SweetAlert-toast style.

import { reactive } from 'vue'

export type ToastKind = 'success' | 'error' | 'info'
export type Toast = { id: number; kind: ToastKind; message: string; duration: number }

let nextId = 1
export const toastState = reactive<{ items: Toast[] }>({ items: [] })

/** duration in ms; 0 disables auto-dismiss (a manual close is still always available). */
export function pushToast(message: string, kind: ToastKind = 'info', duration = 5000): void {
  const trimmed = message.trim()
  if (!trimmed) return
  const id = nextId++
  toastState.items.push({ id, kind, message: trimmed, duration })
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration)
  }
}

export function dismissToast(id: number): void {
  const index = toastState.items.findIndex(item => item.id === id)
  if (index !== -1) toastState.items.splice(index, 1)
}
