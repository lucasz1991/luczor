<script setup lang="ts">
const props = defineProps<{ autoExecuteMutatingTools: boolean }>()
const emit = defineEmits<{
  (event: 'update:autoExecuteMutatingTools', value: boolean): void
}>()

function toggleAutoExecution(): void {
  emit('update:autoExecuteMutatingTools', !props.autoExecuteMutatingTools)
}
</script>

<template>
  <div class="lz-section">
    <div class="lz-section__head">
      <h3>Ausführung & Freigaben</h3>
      <p>Steuert, ob erlaubte datenverändernde Tools einzeln bestätigt werden müssen.</p>
    </div>
    <div class="lz-card">
      <div class="lz-card__head">
        <div>
          <div class="lz-card__title">Datenverändernde Tools automatisch ausführen</div>
          <div class="lz-card__meta">Überspringt die Einzelbestätigung nur im Modus „Handeln“.</div>
        </div>
        <button
          type="button"
          class="lz-switch"
          :class="{ 'is-on': autoExecuteMutatingTools }"
          :aria-pressed="autoExecuteMutatingTools"
          aria-label="Datenverändernde Tools automatisch ausführen"
          @click="toggleAutoExecution"
        >
          <span />
        </button>
      </div>
      <p class="lz-hint">
        Beobachten bleibt strikt schreibgeschützt. Der Not-Aus sperrt weiterhin alle Tools. Nicht erlaubte oder
        unbekannte Aktionen werden durch diese Einstellung nicht freigegeben.
      </p>
    </div>
  </div>
</template>
