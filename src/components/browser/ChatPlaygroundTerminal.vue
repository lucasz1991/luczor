<script setup lang="ts">
import { computed, ref } from 'vue'
import AiIcon from '@/components/ai/AiIcon.vue'
import { executionGate } from '@/services/executionGate'
import { terminalTools } from '@/services/tools/terminal'
import { requestPlaygroundAction } from '@/services/chatPlaygroundNative'
import { chatPlaygroundToolSessionId } from '@/services/chatPlayground'

const props = defineProps<{
  projectId: string
  conversationId: string
  workspaceName: string
  workspaceReady: boolean
  mode: 'observe' | 'act' | 'unrestricted'
  killSwitch: boolean
  detached?: boolean
}>()
const runtime = ref<'node' | 'python'>('node')
const codePlaceholder = computed(() =>
  runtime.value === 'node' ? 'console.log("Hallo aus dem Projekt")' : 'print("Hallo aus dem Projekt")'
)
const code = ref('')
const output = ref('')
const error = ref('')
const reviewing = ref(false)
const busy = ref(false)
const canRun = computed(
  () => props.workspaceReady && props.mode !== 'observe' && !props.killSwitch && !!code.value.trim()
)

async function run() {
  if (!canRun.value || busy.value) return
  busy.value = true
  reviewing.value = false
  error.value = ''
  output.value = ''
  try {
    const result = props.detached
      ? await requestPlaygroundAction({
          type: 'terminal_run',
          runtime: runtime.value,
          code: code.value,
          timeoutSeconds: 30,
        })
      : await terminalTools[0]!.execute(
          { runtime: runtime.value, code: code.value, timeout_seconds: 30 },
          {
            projectId: props.projectId,
            execution: executionGate.capture(
              undefined,
              { projectId: props.projectId, conversationId: props.conversationId },
              props.mode
            ),
            inferenceTarget: 'local',
            toolSessionId: chatPlaygroundToolSessionId(props.projectId, props.conversationId),
          }
        )
    output.value = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="playground-terminal" aria-label="Projekt-Terminal">
    <header class="playground-terminal__head">
      <div>
        <strong>{{ workspaceName || 'Projekt-Terminal' }}</strong
        ><small>Node.js oder Python · begrenzter Projektlauf</small>
      </div>
      <label
        >Runtime
        <select v-model="runtime" aria-label="Terminal-Laufzeit">
          <option value="node">Node.js</option>
          <option value="python">Python</option>
        </select>
      </label>
    </header>
    <div class="playground-terminal__editor">
      <textarea
        v-model="code"
        :disabled="busy"
        :placeholder="codePlaceholder"
        aria-label="Code im Projekt-Terminal"
        spellcheck="false"
      />
      <div class="playground-terminal__actions">
        <span>{{
          !workspaceReady
            ? 'Projektordner fehlt'
            : killSwitch
              ? 'Not-Aus aktiv'
              : mode === 'observe'
                ? 'Steuerungsmodus „Beobachten“'
                : 'Auf den gebundenen Projektordner beschränkt'
        }}</span>
        <button v-if="!reviewing" type="button" :disabled="!canRun || busy" @click="reviewing = true">
          <AiIcon name="play" :size="13" /> {{ busy ? 'Läuft…' : 'Ausführen' }}
        </button>
        <template v-else>
          <button type="button" class="is-subtle" @click="reviewing = false">Abbrechen</button>
          <button type="button" :disabled="!canRun || busy" @click="run">
            <AiIcon name="check" :size="13" /> Node/Python jetzt starten
          </button>
        </template>
      </div>
      <aside v-if="reviewing" class="playground-terminal__review" aria-live="polite">
        <strong>Code im gebundenen Projektordner ausführen?</strong>
        <pre>{{ code }}</pre>
        <small>Maximale Laufzeit: 30 Sekunden. Die Ausgabe bleibt in diesem Tab.</small>
      </aside>
    </div>
    <div v-if="busy || output || error" class="playground-terminal__output" aria-live="polite">
      <span class="playground-terminal__label">{{ busy ? 'Läuft' : error ? 'Fehler' : 'Ausgabe' }}</span>
      <pre v-if="output">{{ output }}</pre>
      <pre v-if="error" class="is-error">{{ error }}</pre>
    </div>
  </section>
</template>

<style scoped>
.playground-terminal {
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  color: var(--ai-ink);
  font: 12px/1.45 var(--ai-font);
}
.playground-terminal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ai-line);
}
.playground-terminal__head > div {
  display: grid;
  gap: 2px;
}
.playground-terminal__head small {
  color: var(--ai-faint);
  font-size: 10px;
}
.playground-terminal__head label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ai-faint);
  font-size: 10px;
}
.playground-terminal select {
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  padding: 5px 8px;
  background: var(--ai-surface);
  color: var(--ai-ink);
  font: inherit;
}
.playground-terminal__editor {
  display: grid;
  gap: 8px;
  padding: 12px;
}
.playground-terminal__editor textarea {
  width: 100%;
  min-height: 145px;
  max-height: 40vh;
  resize: vertical;
  box-sizing: border-box;
  border: 1px solid var(--ai-line);
  border-radius: 7px;
  padding: 10px;
  background: var(--ai-inset, var(--ai-page));
  color: var(--ai-ink);
  font:
    12px/1.55 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.playground-terminal__editor textarea:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 2px;
}
.playground-terminal__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.playground-terminal__actions span {
  margin-right: auto;
  color: var(--ai-faint);
  font-size: 10px;
}
.playground-terminal__actions button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  padding: 6px 9px;
  background: transparent;
  color: var(--ai-ink);
  font: inherit;
  cursor: pointer;
}
.playground-terminal__actions button:hover:not(:disabled) {
  border-color: var(--ai-accent);
}
.playground-terminal__actions button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.playground-terminal__actions .is-subtle {
  color: var(--ai-muted);
}
.playground-terminal__review {
  display: grid;
  gap: 7px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--ai-accent) 40%, var(--ai-line));
  border-radius: 7px;
  background: var(--ai-surface);
}
.playground-terminal__review pre,
.playground-terminal__output pre {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font:
    11px/1.5 ui-monospace,
    SFMono-Regular,
    Consolas,
    monospace;
}
.playground-terminal__review small,
.playground-terminal__label {
  color: var(--ai-faint);
  font-size: 10px;
}
.playground-terminal__output {
  display: grid;
  gap: 6px;
  min-height: 0;
  overflow: auto;
  padding: 10px 14px;
  border-top: 1px solid var(--ai-line);
}
.playground-terminal__output .is-error {
  color: var(--ai-red, #f99);
}
</style>
