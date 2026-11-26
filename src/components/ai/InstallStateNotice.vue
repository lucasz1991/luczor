<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { restartAfterUpdate, watchInstallState, type InstallState } from '@/services/installState'
import { pushToast } from '@/services/toast'

const props = defineProps<{ busy: boolean }>()
const state = ref<InstallState>('unchanged')
const dismissed = ref(false)
const restarting = ref(false)
let stop: (() => void) | undefined
let unmounted = false

onMounted(() => {
  void watchInstallState(next => {
    if (next !== state.value) dismissed.value = false
    state.value = next
  }).then(unlisten => {
    if (unmounted) unlisten()
    else stop = unlisten
  })
})
onBeforeUnmount(() => {
  unmounted = true
  stop?.()
})

async function restart() {
  restarting.value = true
  try {
    await restartAfterUpdate()
  } catch {
    restarting.value = false
    pushToast('Neustart nicht möglich. Bitte Luczor über das Tray-Menü beenden und neu starten.', 'error')
  }
}
</script>

<template>
  <aside v-if="state !== 'unchanged' && !dismissed" class="install-notice" role="status" aria-live="polite">
    <template v-if="state === 'replaced'">
      <strong>Neue Luczor-Version installiert</strong>
      <p>Dieses Fenster läuft noch mit der vorherigen Version. Die neue Version startet nach einem Neustart.</p>
      <p v-if="props.busy" class="install-notice__warning">
        Es läuft noch ein Auftrag. Ein Neustart beendet ihn wie „Beenden“ im Tray-Menü.
      </p>
      <div class="install-notice__actions">
        <button type="button" class="install-notice__primary" :disabled="restarting" @click="restart">
          {{ restarting ? 'Wird neu gestartet …' : 'Jetzt neu starten' }}
        </button>
        <button type="button" :disabled="restarting" @click="dismissed = true">Später</button>
      </div>
    </template>
    <template v-else>
      <strong>Luczor wurde deinstalliert</strong>
      <p>
        Dieses Fenster läuft weiter, bis du Luczor über „Beenden“ im Tray-Menü schließt. Chats, Einstellungen und
        Modelle bleiben erhalten.
      </p>
      <div class="install-notice__actions">
        <button type="button" @click="dismissed = true">Verstanden</button>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.install-notice {
  position: fixed;
  top: 1rem;
  left: 50%;
  z-index: 10000;
  width: min(27rem, calc(100vw - 2rem));
  padding: 1rem;
  transform: translateX(-50%);
  border: 1px solid var(--border, #3b424c);
  border-radius: 12px;
  background: var(--panel, #1d2026);
  color: var(--text, #e9edf3);
  box-shadow: 0 10px 32px #0004;
  font-size: 0.82rem;
  line-height: 1.5;
}
.install-notice p {
  margin: 0.4rem 0 0;
  color: var(--muted, #aeb7c5);
}
.install-notice .install-notice__warning {
  color: var(--ai-orange, #e5a35a);
}
.install-notice__actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.8rem;
}
.install-notice button {
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--border, #3b424c);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.install-notice button:disabled {
  cursor: default;
  opacity: 0.6;
}
.install-notice .install-notice__primary {
  border-color: #70c9dc;
  background: #70c9dc22;
}
.install-notice button:focus-visible {
  outline: 2px solid #70c9dc;
  outline-offset: 3px;
}
</style>
