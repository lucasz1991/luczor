<script setup lang="ts">
import { watch } from 'vue'
import { assistantProfileState as state, refreshAssistantProfile } from '@/services/assistantProfile'
const props = defineProps<{ active: boolean }>()
watch(
  () => props.active,
  value => {
    if (value) void refreshAssistantProfile()
  },
  { immediate: true }
)
</script>
<template>
  <section class="assistant-profile" aria-label="Persönlichkeit und Skills">
    <header>
      <strong>Persönlichkeit &amp; Skills</strong
      ><button type="button" class="ai-icon-button" :disabled="state.loading" @click="refreshAssistantProfile(true)">
        {{ state.loading ? 'Lädt…' : 'Aktualisieren' }}
      </button>
    </header>
    <p>{{ state.message }}</p>
    <details v-if="state.profile.persona">
      <summary>{{ state.profile.persona.name }}</summary>
      <p class="profile-prompt">{{ state.profile.persona.prompt }}</p>
    </details>
    <p v-else>Keine Persönlichkeit ausgewählt.</p>
    <details v-for="skill in state.profile.skills" :key="skill.slug">
      <summary>{{ skill.name }}</summary>
      <p>{{ skill.description }}</p>
      <p class="profile-prompt">{{ skill.prompt }}</p>
    </details>
    <p v-if="!state.profile.skills.length">Keine Prompt-Skills aktiv.</p>
    <small>Stil und Fachwissen für den lokalen Chat. In der Admin-App bearbeitbar.</small>
  </section>
</template>
<style scoped>
.assistant-profile {
  border: 1px solid var(--ai-border, #343443);
  border-radius: 12px;
  padding: 14px;
  font-size: 12px;
  line-height: 1.55;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
header strong {
  font-size: 13px;
}
p {
  margin: 8px 0;
  overflow-wrap: anywhere;
}
small {
  display: block;
  margin-top: 10px;
  opacity: 0.7;
}
details {
  border-top: 1px solid var(--ai-border, #343443);
  padding: 9px 0;
}
summary {
  cursor: pointer;
}
.profile-prompt {
  white-space: pre-wrap;
}
</style>
