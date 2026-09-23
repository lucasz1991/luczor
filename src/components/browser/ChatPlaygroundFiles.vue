<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AiIcon from '@/components/ai/AiIcon.vue'
import {
  chatPlaygroundToolSessionId,
  setPlaygroundDirectory,
  type ChatPlaygroundState,
} from '@/services/chatPlayground'
import { getTool } from '@/services/tools/registry'
import { executionGate } from '@/services/executionGate'
import { requestPlaygroundAction } from '@/services/chatPlaygroundNative'

type FileEntry = { path: string; name: string; kind: string; bytes: number }
const props = defineProps<{
  projectId: string
  conversationId: string
  projectName: string
  workspaceName: string
  workspaceReady: boolean
  mode: 'observe' | 'act' | 'unrestricted'
  state: ChatPlaygroundState
  detached?: boolean
}>()
const emit = defineEmits<{ openFile: [file: { path: string; content: string }]; bindFolder: [] }>()
const loading = ref(new Set<string>())
const error = ref('')
const filter = ref('')
const flatEntries = computed(() => {
  const rows: Array<FileEntry & { depth: number; expanded: boolean }> = []
  const add = (directory: string, depth: number) => {
    for (const entry of props.state.directories.get(directory) ?? []) {
      if (filter.value && !entry.path.toLowerCase().includes(filter.value.toLowerCase())) continue
      const expanded = props.state.expandedDirectories.has(entry.path)
      rows.push({ ...entry, depth, expanded })
      if (entry.kind === 'directory' && expanded) add(entry.path, depth + 1)
    }
  }
  add('.', 0)
  return rows
})

function context() {
  const execution = executionGate.capture(
    undefined,
    { projectId: props.projectId, conversationId: props.conversationId },
    props.mode
  )
  return {
    projectId: props.projectId,
    execution,
    inferenceTarget: 'local' as const,
    toolSessionId: chatPlaygroundToolSessionId(props.projectId, props.conversationId),
  }
}

async function listDirectory(path: string) {
  if (!props.workspaceReady || loading.value.has(path)) return
  loading.value = new Set(loading.value).add(path)
  error.value = ''
  try {
    const result = (
      props.detached
        ? await requestPlaygroundAction({ type: 'files_list', path })
        : await (() => {
            const tool = getTool('fs_list')
            if (!tool) throw new Error('Dateizugriff ist nicht verfügbar.')
            return tool.execute({ path, max_depth: 1, limit: 200 }, context())
          })()
    ) as {
      entries?: FileEntry[]
      truncated?: boolean
    }
    setPlaygroundDirectory(props.state, path, result.entries ?? [])
    if (result.truncated) error.value = 'Die Liste ist begrenzt. Verwende die Suche für weitere Dateien.'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    const next = new Set(loading.value)
    next.delete(path)
    loading.value = next
  }
}

async function toggle(entry: FileEntry) {
  if (entry.kind === 'directory') {
    if (props.state.expandedDirectories.has(entry.path)) props.state.expandedDirectories.delete(entry.path)
    else {
      props.state.expandedDirectories.add(entry.path)
      await listDirectory(entry.path)
    }
    return
  }
  error.value = ''
  try {
    const result = (
      props.detached
        ? await requestPlaygroundAction({ type: 'files_read', path: entry.path })
        : await (() => {
            const tool = getTool('fs_read')
            if (!tool) throw new Error('Dateizugriff ist nicht verfügbar.')
            return tool.execute({ path: entry.path, max_bytes: 65_536 }, context())
          })()
    ) as {
      content?: string
      path?: string
    }
    emit('openFile', { path: result.path ?? entry.path, content: result.content ?? '' })
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

watch(
  () => [props.projectId, props.conversationId, props.workspaceReady],
  () => void listDirectory('.'),
  {
    immediate: true,
  }
)
</script>

<template>
  <section class="playground-files" aria-label="Projektdateien">
    <header class="playground-files__head">
      <div>
        <strong>{{ workspaceName || projectName }}</strong>
        <small>{{ workspaceReady ? 'Projektordner' : 'Kein Projektordner verbunden' }}</small>
      </div>
      <button v-if="!workspaceReady" type="button" class="playground-files__bind" @click="emit('bindFolder')">
        <AiIcon name="folder" :size="13" /> Ordner verbinden
      </button>
      <label>
        <AiIcon name="search" :size="13" />
        <input v-model="filter" placeholder="Dateien suchen" aria-label="Dateien im Projektordner suchen" />
      </label>
    </header>
    <p v-if="!workspaceReady" class="playground-files__empty">
      Verbinde in den Projekteinstellungen einen Projektordner, um seine Dateien hier zu durchsuchen.
    </p>
    <p v-else-if="!flatEntries.length && !loading.has('.')" class="playground-files__empty">
      Dieser Ordner enthält keine angezeigten Dateien.
    </p>
    <nav v-else class="playground-files__tree" aria-label="Dateistruktur">
      <button
        v-for="entry in flatEntries"
        :key="entry.path"
        type="button"
        :style="{ '--tree-depth': entry.depth }"
        :aria-expanded="entry.kind === 'directory' ? entry.expanded : undefined"
        @click="toggle(entry)"
      >
        <AiIcon :name="entry.kind === 'directory' ? 'folder' : 'code'" :size="14" />
        <span>{{ entry.name }}</span>
        <small v-if="entry.kind !== 'directory'">
          {{ entry.bytes < 1024 ? entry.bytes + ' B' : (entry.bytes / 1024).toFixed(0) + ' KB' }}
        </small>
        <span v-if="loading.has(entry.path)" class="playground-files__busy" aria-label="Wird geladen">…</span>
      </button>
      <p v-if="loading.has('.')" class="playground-files__empty">Ordner wird gelesen…</p>
    </nav>
    <p v-if="error" class="playground-files__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.playground-files {
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  color: var(--ai-ink);
  font: 12px/1.45 var(--ai-font);
}
.playground-files__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--ai-line);
}
.playground-files__head > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.playground-files__head strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.playground-files__head small,
.playground-files__tree small {
  color: var(--ai-faint);
  font-size: 10px;
}
.playground-files__head label {
  display: flex;
  align-items: center;
  gap: 7px;
  width: min(280px, 45%);
  padding: 6px 8px;
  border: 1px solid var(--ai-line);
  border-radius: 7px;
  color: var(--ai-faint);
}
.playground-files__bind {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 7px;
  padding: 0 9px;
  border: 1px solid var(--ai-line);
  border-radius: 6px;
  background: transparent;
  color: var(--ai-muted);
  font: 10px var(--ai-font);
  cursor: pointer;
}
.playground-files__bind:hover {
  border-color: var(--ai-accent);
  color: var(--ai-ink);
}
.playground-files__head input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ai-ink);
  font: inherit;
}
.playground-files__head input:focus-visible {
  outline: 0;
  box-shadow: none;
}
.playground-files__tree {
  overflow: auto;
  padding: 6px 8px;
}
.playground-files__tree button {
  display: flex;
  width: 100%;
  min-height: 28px;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 4px calc(8px + var(--tree-depth) * 17px);
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ai-muted);
  text-align: left;
  cursor: pointer;
}
.playground-files__tree button:hover,
.playground-files__tree button:focus-visible {
  background: var(--ai-hover);
  color: var(--ai-ink);
}
.playground-files__tree button > span:first-of-type {
  overflow: hidden;
  flex: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.playground-files__empty {
  margin: auto;
  padding: 22px;
  color: var(--ai-faint);
  text-align: center;
}
.playground-files__error {
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid var(--ai-line);
  color: var(--ai-red, #f99);
}
.playground-files__busy {
  color: var(--ai-accent);
}
</style>
