<script setup lang="ts">
import { pendingPayloadApproval, resolvePayloadApproval } from '@/services/payloadApproval'
</script>

<template>
  <Teleport to="body">
    <div
      v-if="pendingPayloadApproval"
      class="payload-approval"
      role="dialog"
      aria-modal="true"
      aria-labelledby="payload-title"
      @keydown.esc="resolvePayloadApproval(pendingPayloadApproval.id, false)"
    >
      <section>
        <h2 id="payload-title">{{ pendingPayloadApproval.title }}</h2>
        <p>Ziel: {{ pendingPayloadApproval.destination }}</p>
        <p>Einmalige Freigabe · verfällt nach zwei Minuten. Der folgende Inhalt wird übertragen.</p>
        <p v-if="pendingPayloadApproval.kind !== 'result'">
          Der API-Server kann konfigurierte Systemanweisungen ergänzen. Diese sind in dieser Vorschau nicht enthalten.
        </p>
        <pre tabindex="0">{{ pendingPayloadApproval.content }}</pre>
        <small>SHA-256: {{ pendingPayloadApproval.hash }}</small>
        <footer>
          <button type="button" autofocus @click="resolvePayloadApproval(pendingPayloadApproval.id, false)">
            Ablehnen
          </button>
          <button type="button" @click="resolvePayloadApproval(pendingPayloadApproval.id, true)">
            Dieses Paket einmal freigeben
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.payload-approval {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: #080b12cc;
}
section {
  width: min(900px, 100%);
  max-height: 90dvh;
  overflow: auto;
  padding: 28px;
  border: 1px solid #4e5971;
  border-radius: 14px;
  color: #edf3fc;
  background: #141c2a;
}
h2 {
  margin: 0 0 16px;
  font-size: 1.35rem;
}
p {
  margin: 10px 0;
}
pre {
  max-height: 48dvh;
  overflow: auto;
  padding: 16px;
  border: 1px solid #3a485e;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #0b111d;
}
small {
  overflow-wrap: anywhere;
}
footer {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 20px;
}
button {
  padding: 10px 16px;
  border: 1px solid #7795bc;
  border-radius: 6px;
  background: #263c59;
  color: white;
  cursor: pointer;
}
</style>
