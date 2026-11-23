<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { claudeMainPolicy, type ClaudeKeySource } from '@/services/inference/claudeMain'
import {
  ClaudeAccessError,
  claudeAccessMessage,
  fetchClaudeAccess,
  NO_CLAUDE_ACCESS,
  removeClaudeKey,
  saveClaudeKey,
  setClaudeKeySource,
  setClaudeProviderFallback,
  syncClaudeAccessEnabled,
  testClaudeAccess,
  type ClaudeAccessStatus,
} from '@/services/inference/claudeAccess'

// Access to the Anthropic API only. Model and thinking depth are chosen in the composer.
// The key lives in `keyInput` just long enough to be sent once; it is never prefilled or persisted.
const status = ref<ClaudeAccessStatus>(NO_CLAUDE_ACCESS)
const loaded = ref(false)
const loadError = ref('')
const busy = ref<'' | 'load' | 'save' | 'test' | 'remove' | 'source' | 'options'>('load')
const keyInput = ref('')
const confirmRemove = ref(false)
const result = ref<{ ok: boolean; text: string } | null>(null)
let disposed = false

const SOURCES: ReadonlyArray<{ value: ClaudeKeySource; title: string; hint: string }> = [
  { value: 'user', title: 'Eigener Schlüssel', hint: 'Dein persönlicher Anthropic-API-Key' },
  { value: 'organization', title: 'Organisationszugang', hint: 'Vom Admin bereitgestellt' },
]
function sourceAllowed(source: ClaudeKeySource): boolean {
  return claudeMainPolicy.value.keySources.includes(source) && status.value.allowedSources.includes(source)
}
function sourceReason(source: ClaudeKeySource): string {
  if (!loaded.value || sourceAllowed(source)) return ''
  return source === 'user'
    ? 'Eigene Schlüssel sind auf diesem Server nicht freigegeben.'
    : 'Der Organisationszugang ist für dein Konto nicht freigegeben.'
}
/** What the forms act on: the stored source, else the only one that is permitted. */
const activeSource = computed<ClaudeKeySource | null>(() => {
  if (status.value.source && sourceAllowed(status.value.source)) return status.value.source
  return SOURCES.find(source => sourceAllowed(source.value))?.value ?? null
})
const ownKey = computed(() => activeSource.value === 'user')
/** The key form also shows (locked) while the status is unknown; only an organization access hides it. */
const keyForm = computed(() => activeSource.value !== 'organization')
const working = computed(() => busy.value !== '')
const badge = computed(() => {
  if (!loaded.value) return { ok: false, text: loadError.value ? 'Status unbekannt' : 'Wird geladen' }
  return status.value.connected ? { ok: true, text: 'Verbunden' } : { ok: false, text: 'Nicht verbunden' }
})
const testedAt = computed(() => {
  const time = status.value.lastTestedAt ? Date.parse(status.value.lastTestedAt) : Number.NaN
  if (!Number.isFinite(time)) return ''
  return new Date(time).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
})

function message(error: unknown): string {
  // Only fixed texts: a transport error could carry server prose, which is never shown here.
  return error instanceof ClaudeAccessError ? error.message : claudeAccessMessage('unknown')
}
async function apply(next: ClaudeAccessStatus): Promise<void> {
  if (disposed) return
  status.value = next
  loaded.value = true
  loadError.value = ''
  try {
    await syncClaudeAccessEnabled(next)
  } catch {
    result.value = { ok: false, text: 'Der Zugangsstatus konnte auf diesem Gerät nicht gespeichert werden.' }
  }
}
async function run(kind: Exclude<typeof busy.value, ''>, action: () => Promise<void>): Promise<void> {
  if (busy.value && busy.value !== 'load') return
  busy.value = kind
  if (kind !== 'load') result.value = null
  try {
    await action()
  } catch (error) {
    if (disposed) return
    if (kind === 'load') loadError.value = message(error)
    else result.value = { ok: false, text: message(error) }
  } finally {
    if (!disposed) busy.value = ''
  }
}
function load() {
  return run('load', async () => apply(await fetchClaudeAccess()))
}
function save() {
  // Take the key out of the field before the request, so it is gone after every attempt.
  const key = keyInput.value
  keyInput.value = ''
  return run('save', async () => {
    await apply(await saveClaudeKey(key))
    if (disposed) return
    result.value = status.value.connected
      ? { ok: true, text: 'Schlüssel geprüft und auf dem Server gespeichert.' }
      : { ok: false, text: 'Der Schlüssel wurde übertragen, der Zugang ist aber noch nicht verbunden.' }
  })
}
function test() {
  return run('test', async () => {
    const outcome = await testClaudeAccess()
    if (disposed) return
    result.value = { ok: outcome.ok, text: outcome.message }
    await apply(await fetchClaudeAccess())
  })
}
function remove() {
  confirmRemove.value = false
  return run('remove', async () => {
    await apply(await removeClaudeKey())
    if (!disposed) result.value = { ok: true, text: 'Der Schlüssel wurde vom Server entfernt.' }
  })
}
function chooseSource(source: ClaudeKeySource) {
  if (!sourceAllowed(source) || source === status.value.source) return
  confirmRemove.value = false
  return run('source', async () => apply(await setClaudeKeySource(source)))
}
function toggleFallback() {
  return run('options', async () => apply(await setClaudeProviderFallback(!status.value.providerFallback)))
}

onMounted(load)
onBeforeUnmount(() => {
  disposed = true
  keyInput.value = ''
})
</script>

<template>
  <section class="lz-section" aria-label="Claude API">
    <div class="lz-section__head">
      <h3>Claude API</h3>
      <p>Zugang zur Anthropic-API. Modell und Denktiefe werden im Chat gewählt, nicht hier.</p>
    </div>

    <p v-if="!claudeMainPolicy.allowed" class="lz-callout claude-api-notice" role="status">
      <span>
        <b>Die Claude-Modi sind auf diesem Server nicht freigeschaltet.</b>
        „Claude + lokal“ und „Nur Claude“ lassen sich deshalb noch nicht auswählen. Einen Zugang kannst du bereits
        hinterlegen; er wird genutzt, sobald dein Administrator die Modi freigibt.
      </span>
    </p>
    <div v-if="loadError" class="lz-card" role="alert">
      <p class="lz-error">{{ loadError }}</p>
      <div class="lz-actions">
        <button type="button" class="lz-btn lz-btn--ghost" :disabled="working" @click="load">Erneut laden</button>
      </div>
    </div>

    <div class="lz-card">
      <div class="claude-api-cardhead">
        <div id="claude-api-source-title" class="lz-card__title">Schlüsselquelle</div>
        <div class="lz-card__meta">gilt für dein Konto</div>
      </div>
      <div class="lz-segment claude-api-sources" role="radiogroup" aria-labelledby="claude-api-source-title">
        <button
          v-for="source in SOURCES"
          :key="source.value"
          type="button"
          role="radio"
          class="lz-segment__item"
          :class="{ 'is-active': activeSource === source.value }"
          :aria-checked="activeSource === source.value"
          :disabled="working || !sourceAllowed(source.value)"
          :title="sourceReason(source.value) || undefined"
          @click="chooseSource(source.value)"
        >
          <span>{{ source.title }}</span>
          <small>{{ sourceReason(source.value) || source.hint }}</small>
        </button>
      </div>
      <p v-if="loaded && !activeSource" class="lz-hint" role="status">
        Für dein Konto ist derzeit keine Schlüsselquelle freigegeben. Bitte wende dich an deinen Administrator.
      </p>
    </div>

    <div class="lz-card">
      <div class="claude-api-cardhead">
        <div class="lz-card__title">API-Schlüssel</div>
        <span class="lz-permission__badge" :class="{ 'is-ok': badge.ok }" role="status">
          <i aria-hidden="true" />{{ badge.text }}
        </span>
      </div>
      <template v-if="keyForm">
        <div>
          <label class="lz-label" for="claude-api-key">Anthropic API-Key</label>
          <p v-if="status.maskedKey" class="claude-api-masked">
            <span class="lz-hint">Hinterlegt:</span> <code>{{ status.maskedKey }}</code>
          </p>
          <input
            id="claude-api-key"
            v-model="keyInput"
            type="password"
            class="lz-input claude-api-key"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            maxlength="512"
            :placeholder="status.maskedKey ? 'Neuen Schlüssel eingeben, um ihn zu ersetzen' : 'sk-ant-…'"
            :disabled="working || !ownKey"
            aria-describedby="claude-api-key-hint"
            @keydown.enter.prevent="ownKey && keyInput.trim() && save()"
          />
          <p id="claude-api-key-hint" class="lz-hint">
            Der Schlüssel wird einmalig über HTTPS an deinen Luczor-Server übertragen und dort verschlüsselt
            gespeichert. Er wird nie wieder im Klartext angezeigt und nicht in den Einstellungen dieses Geräts abgelegt.
          </p>
        </div>
      </template>
      <p v-else class="lz-hint">
        Dein Administrator stellt den Zugang bereit. Auf diesem Gerät wird kein Schlüssel eingegeben oder gespeichert.
      </p>
      <div class="lz-actions">
        <button type="button" class="lz-btn lz-btn--ghost" :disabled="working || !status.connected" @click="test">
          {{ busy === 'test' ? 'Wird geprüft …' : keyForm ? 'Schlüssel prüfen' : 'Zugang prüfen' }}
        </button>
        <template v-if="keyForm">
          <button
            type="button"
            class="lz-btn lz-btn--primary"
            :disabled="working || !ownKey || !keyInput.trim()"
            @click="save"
          >
            {{ busy === 'save' ? 'Wird gespeichert …' : 'Schlüssel speichern' }}
          </button>
          <button
            v-if="!confirmRemove"
            type="button"
            class="lz-btn lz-btn--ghost claude-api-danger"
            :disabled="working || !ownKey || !status.maskedKey"
            @click="confirmRemove = true"
          >
            {{ busy === 'remove' ? 'Wird entfernt …' : 'Entfernen' }}
          </button>
        </template>
      </div>
      <div v-if="confirmRemove" class="claude-api-confirm" role="alertdialog" aria-label="Schlüssel entfernen">
        <span>Schlüssel wirklich vom Server entfernen? Die Claude-Modi sind danach gesperrt.</span>
        <span class="lz-actions">
          <button type="button" class="lz-btn lz-btn--ghost claude-api-danger" :disabled="working" @click="remove">
            Endgültig entfernen
          </button>
          <button type="button" class="lz-btn lz-btn--ghost" @click="confirmRemove = false">Abbrechen</button>
        </span>
      </div>
      <p
        v-if="result"
        class="lz-result"
        :class="result.ok ? 'is-ok' : 'is-fail'"
        :role="result.ok ? 'status' : 'alert'"
      >
        {{ result.text }}
      </p>
      <p v-else-if="status.connected && testedAt" class="lz-result is-ok" role="status">
        Verbindung geprüft · {{ claudeMainPolicy.models.length }} freigegebene Claude-Modelle verfügbar · zuletzt
        geprüft am {{ testedAt }}
      </p>
    </div>

    <div class="lz-card">
      <div class="claude-api-cardhead">
        <div class="lz-card__title">API-Verhalten</div>
        <div class="lz-card__meta">gilt für alle Chats</div>
      </div>
      <div class="lz-row">
        <span id="claude-api-fallback-label" class="lz-rowlabel">
          Bei Ablehnung zuerst ein Claude-Ausweichmodell versuchen
        </span>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': status.providerFallback }"
          role="switch"
          :aria-checked="status.providerFallback"
          aria-labelledby="claude-api-fallback-label"
          :disabled="working || !loaded"
          @click="toggleFallback"
        >
          <span />
        </button>
      </div>
      <p class="lz-hint">
        Nutzt die serverseitige Ausweichfunktion von Anthropic, bevor der Modus „Claude + lokal“ an das lokale Modell
        übergibt.
      </p>
    </div>

    <div class="lz-callout">
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M21 2l-2 2m-7.5 7.5L19 4M7 14a4 4 0 1 1 3.9-5M7 18h4l1.5-1.5L14 18h2l1.5-1.5L19 18h2v-2l-5.5-5.5" />
      </svg>
      <span>
        Schlüssel erstellst du in der Anthropic-Konsole. Verwende einen eigenen Schlüssel nur für Luczor, damit du ihn
        bei Bedarf einzeln widerrufen kannst.
      </span>
    </div>
  </section>
</template>

<style scoped>
.claude-api-cardhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.claude-api-notice {
  margin: 0;
  border-color: var(--energy-border, rgba(212, 160, 84, 0.28));
  background: var(--energy-wash, rgba(212, 160, 84, 0.1));
  font-size: 12px;
}
.claude-api-notice b {
  color: var(--text-primary);
}
.claude-api-sources {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.claude-api-sources .lz-segment__item.is-active {
  background: linear-gradient(145deg, rgba(143, 123, 216, 0.34), rgba(90, 71, 173, 0.3));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    0 0 0 1px rgba(143, 123, 216, 0.45);
}
.claude-api-sources .lz-segment__item.is-active small {
  color: var(--cy-soft);
}
.claude-api-sources .lz-segment__item small {
  text-align: center;
}
.claude-api-sources .lz-segment__item:disabled {
  cursor: not-allowed;
}
.claude-api-sources .lz-segment__item:disabled:not(.is-active) {
  opacity: 0.5;
}
.claude-api-sources .lz-segment__item:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.claude-api-masked {
  margin: 0 0 6px;
}
.claude-api-masked code,
.claude-api-key {
  font-family: var(--font-mono);
  letter-spacing: 0.06em;
}
.claude-api-masked code {
  font-size: 12px;
  color: var(--cy-soft);
}
.claude-api-danger {
  color: var(--danger-soft);
}
.claude-api-confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--danger-soft) 40%, transparent);
  border-radius: 12px;
  background: var(--danger-wash, rgba(240, 148, 155, 0.08));
  font-size: 12px;
  color: var(--text-secondary);
}
@media (max-width: 480px) {
  .claude-api-sources {
    grid-template-columns: minmax(0, 1fr);
    border-radius: var(--r-md);
  }
}
</style>
