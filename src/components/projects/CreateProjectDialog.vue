<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
const props = defineProps<{ open: boolean; busy?: boolean; error?: string }>()
const emit = defineEmits<{ close: []; create: [name: string] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const field = ref<HTMLInputElement | null>(null)
const name = ref('')
watch(
  () => props.open,
  async open => {
    await nextTick()
    if (open) {
      name.value = ''
      dialog.value?.showModal()
      field.value?.focus()
    } else dialog.value?.close()
  },
  { immediate: true }
)
</script>
<template>
  <dialog
    ref="dialog"
    class="create-project"
    aria-labelledby="create-project-title"
    @cancel.prevent="!busy && emit('close')"
  >
    <form @submit.prevent="name.trim() && !busy && emit('create', name.trim())">
      <header>
        <h2 id="create-project-title">Projekt erstellen</h2>
        <button type="button" aria-label="Schließen" :disabled="busy" @click="emit('close')">×</button>
      </header>
      <label for="new-project-name">Projektname</label>
      <input
        id="new-project-name"
        ref="field"
        v-model="name"
        maxlength="160"
        placeholder="Mein Projekt"
        required
        :disabled="busy"
      />
      <p>Unterhaltungen an einem Ort. Einen Ordner kannst du später in den Projekteinstellungen verknüpfen.</p>
      <p v-if="!isTauri()" class="preview-note">Browser-Vorschau: Änderungen bleiben für diese Sitzung erhalten.</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <footer>
        <button type="button" :disabled="busy" @click="emit('close')">Abbrechen</button
        ><button type="submit" :disabled="busy || !name.trim()">
          {{ busy ? 'Wird erstellt …' : 'Projekt erstellen' }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
<style scoped>
.create-project {
  width: min(420px, calc(100vw - 32px));
  margin: auto;
  padding: 24px;
  border: 1px solid var(--ai-line-strong);
  border-radius: 16px;
  background: var(--ai-surface);
  color: var(--ai-ink);
  box-shadow: var(--shadow-panel);
}
.create-project::backdrop {
  background: #0006;
}
header,
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  margin: 0;
  font-size: 17px;
}
header {
  margin-bottom: 22px;
}
label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
}
input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  background: var(--ai-inset);
  border: 1px solid var(--ai-line-strong);
  border-radius: 8px;
  color: inherit;
  font: inherit;
}
p {
  color: var(--ai-muted);
  font-size: 12px;
  line-height: 1.6;
  margin: 12px 0;
}
.preview-note {
  font-size: 11px;
}
[role='alert'] {
  color: var(--ai-red);
}
footer {
  justify-content: flex-end;
  margin-top: 22px;
}
button {
  padding: 8px 12px;
  border: 1px solid var(--ai-line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
button[type='submit'] {
  background: var(--ai-ink);
  color: var(--ai-page);
}
header button {
  border: 0;
  font-size: 20px;
  padding: 0 6px;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
:is(button, input):focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 3px;
}
</style>
