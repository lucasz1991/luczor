<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_BASE_URL, fetchWithTimeout } from '@/services/api/luczorApi'
import { createDevicePairingPoller, type DevicePairing, type DevicePairingClaim } from '@/services/devicePairing'

const props = defineProps<{ baseUrl: string; clientId: string; connected: boolean; logoutBusy?: boolean }>()
const emit = defineEmits<{ connected: [key: string]; logout: [] }>()
const pairing = ref<DevicePairing | null>(null)
const busy = ref(false)
const notice = ref('')
let epoch = 0

type PairingApproval = Readonly<{ deviceKey: string; userName: string }>

const poller = createDevicePairingPoller<PairingApproval>({
  async claim(current): Promise<DevicePairingClaim<PairingApproval>> {
    busy.value = true
    try {
      const response = await fetchWithTimeout(`${current.baseUrl}/api/v1/auth/device/${current.id}/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ secret: current.secret }),
      })
      if (response.status === 202) return { status: 'pending' }
      if ([404, 410].includes(response.status)) return { status: 'expired' }
      if (!response.ok) throw new Error('pairing_claim_failed')
      const result = await response.json()
      if (typeof result.device_key !== 'string' || result.device_key.length !== 64)
        throw new Error('pairing_claim_invalid')
      return {
        status: 'approved',
        value: { deviceKey: result.device_key, userName: String(result.user?.name ?? 'deinen Benutzer') },
      }
    } finally {
      busy.value = false
    }
  },
  onPending() {
    notice.value = 'Im Browser anmelden und dieses Gerät bestätigen. Die Anmeldung wird automatisch übernommen.'
  },
  onApproved(_current, approval) {
    pairing.value = null
    emit('connected', approval.deviceKey)
    notice.value = `Anmeldung für ${approval.userName} empfangen. Verbindung wird geprüft.`
  },
  onExpired() {
    pairing.value = null
    notice.value = 'Die Browser-Anmeldung ist abgelaufen. Bitte erneut starten.'
  },
  onError() {
    notice.value = 'Die Browserfreigabe wird weiter überprüft. Bitte die Serververbindung prüfen.'
  },
})

onBeforeUnmount(() => {
  epoch++
  poller.cancel()
  pairing.value = null
})
watch(
  () => [props.baseUrl, props.clientId],
  () => {
    epoch++
    poller.cancel()
    pairing.value = null
    notice.value = ''
  }
)

function base() {
  const url = new URL(props.baseUrl.trim() || DEFAULT_BASE_URL)
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  ) {
    throw new Error('Die Anmeldung benötigt HTTPS oder einen lokalen Testserver.')
  }
  return url.href.replace(/\/$/, '')
}

async function start() {
  if (busy.value) return
  busy.value = true
  const current = ++epoch
  poller.cancel()
  pairing.value = null
  try {
    const baseUrl = base()
    const response = await fetchWithTimeout(`${baseUrl}/api/v1/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: props.clientId, name: 'Luczor Desktop' }),
    })
    if (!response.ok) throw new Error(`Anmeldung konnte nicht gestartet werden (HTTP ${response.status}).`)
    const result = await response.json()
    if (!/^[a-f0-9-]{36}$/.test(result.id) || typeof result.secret !== 'string' || result.secret.length !== 64)
      throw new Error('Ungültige Anmeldeantwort.')
    const expiresIn = Number(result.expires_in)
    if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 600)
      throw new Error('Ungültige Anmeldeantwort.')
    if (current !== epoch) return
    // Build the login URL from the selected server; never open a server-supplied redirect.
    const next: DevicePairing = {
      id: result.id,
      secret: result.secret,
      baseUrl,
      url: `${baseUrl}/devices/pair/${result.id}`,
      expiresAt: Date.now() + expiresIn * 1_000,
    }
    await invoke('open_user_link', { payload: { url: next.url } })
    if (current !== epoch) return
    pairing.value = next
    notice.value = 'Im Browser anmelden und dieses Gerät bestätigen. Die Anmeldung wird automatisch übernommen.'
  } catch (error) {
    if (current === epoch) notice.value = error instanceof Error ? error.message : 'Anmeldung fehlgeschlagen.'
  } finally {
    busy.value = false
    if (current === epoch && pairing.value) poller.start(pairing.value)
  }
}

async function manage() {
  try {
    await invoke('open_user_link', { payload: { url: `${base()}/account/devices` } })
  } catch {
    notice.value = 'Die Geräteverwaltung konnte nicht geöffnet werden.'
  }
}
</script>

<template>
  <div class="lz-card">
    <div class="lz-card__title">Benutzerkonto</div>
    <p class="lz-hint">Mit deinem Laravel-Konto anmelden. Jedes Gerät erhält einen eigenen Schlüssel.</p>
    <div class="lz-actions">
      <button type="button" class="lz-btn lz-btn--primary" :disabled="busy || !clientId" @click="start">
        {{ connected ? 'Konto wechseln' : 'Im Browser anmelden' }}
      </button>
      <button v-if="pairing" type="button" class="lz-btn lz-btn--ghost" :disabled="busy" @click="poller.checkNow()">
        Jetzt erneut prüfen
      </button>
      <button
        v-if="connected"
        type="button"
        class="lz-btn lz-btn--ghost"
        :disabled="busy || logoutBusy"
        @click="emit('logout')"
      >
        Abmelden
      </button>
      <button type="button" class="lz-btn lz-btn--ghost" @click="manage">Meine Geräte &amp; Kosten</button>
    </div>
    <p v-if="connected" class="lz-hint">Auf diesem Gerät angemeldet.</p>
    <p v-if="notice" class="lz-hint" role="status">{{ notice }}</p>
  </div>
</template>
