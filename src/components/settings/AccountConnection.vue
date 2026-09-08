<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { DEFAULT_BASE_URL, fetchWithTimeout } from '@/services/api/luczorApi'

const props = defineProps<{ baseUrl: string; clientId: string }>()
const emit = defineEmits<{ connected: [key: string] }>()
const pairing = ref<{ id: string; secret: string; url: string; baseUrl: string } | null>(null)
const busy = ref(false)
const notice = ref('')
let epoch = 0
onBeforeUnmount(() => {
  epoch++
  pairing.value = null
})
watch(
  () => [props.baseUrl, props.clientId],
  () => {
    epoch++
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
    if (current !== epoch) return
    // Build the login URL from the selected server; never open a server-supplied redirect.
    pairing.value = { id: result.id, secret: result.secret, baseUrl, url: `${baseUrl}/devices/pair/${result.id}` }
    await invoke('open_user_link', { payload: { url: pairing.value.url } })
    notice.value = 'Im Browser anmelden, dieses Gerät bestätigen und anschließend „Anmeldung übernehmen“ anklicken.'
  } catch (error) {
    if (current === epoch) notice.value = error instanceof Error ? error.message : 'Anmeldung fehlgeschlagen.'
  } finally {
    busy.value = false
  }
}
async function claim() {
  const current = pairing.value
  if (!current || busy.value) return
  busy.value = true
  const generation = epoch
  try {
    const response = await fetchWithTimeout(`${current.baseUrl}/api/v1/auth/device/${current.id}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ secret: current.secret }),
    })
    if (generation !== epoch) return
    if (response.status === 202) {
      notice.value = 'Bitte zuerst im Browser bestätigen.'
      return
    }
    if (!response.ok) throw new Error(`Anmeldung nicht verfügbar (HTTP ${response.status}). Bitte neu starten.`)
    const result = await response.json()
    if (generation !== epoch) return
    if (typeof result.device_key !== 'string' || result.device_key.length !== 64)
      throw new Error('Ungültige Gerätefreigabe.')
    pairing.value = null
    emit('connected', result.device_key)
    notice.value = `Anmeldung für ${String(result.user?.name ?? 'deinen Benutzer')} empfangen. Verbindung wird geprüft.`
  } catch (error) {
    notice.value = error instanceof Error ? error.message : 'Anmeldung fehlgeschlagen.'
  } finally {
    busy.value = false
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
        Im Browser anmelden
      </button>
      <button v-if="pairing" type="button" class="lz-btn lz-btn--primary" :disabled="busy" @click="claim">
        Anmeldung übernehmen
      </button>
      <button type="button" class="lz-btn lz-btn--ghost" @click="manage">Meine Geräte & Kosten</button>
    </div>
    <p v-if="notice" class="lz-hint" role="status">{{ notice }}</p>
  </div>
</template>
