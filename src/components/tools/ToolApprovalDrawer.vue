<script setup lang="ts">
defineProps<{ mode: 'observe' | 'act' | 'unrestricted'; killSwitch: boolean }>()
</script>

<template>
  <section class="tool-approval-drawer" aria-label="Werkzeugfreigaben">
    <strong>Freigaben</strong>
    <span v-if="killSwitch">Not-Aus aktiv</span>
    <span v-else-if="mode === 'observe'">Beobachten: Änderungen bleiben gesperrt</span>
    <span v-else>Mutierende Tools fragen vor dem Lauf nach Freigabe.</span>
  </section>
</template>
