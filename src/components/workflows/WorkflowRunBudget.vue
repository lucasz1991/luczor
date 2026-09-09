<script setup lang="ts">
import { computed } from 'vue'
import { readWorkflowRunBudget } from '@/services/workflows/runBudget'
import { isTerminalWorkflow, type WorkflowRun } from '@/services/workflows/types'

const props = defineProps<{ run: WorkflowRun; knownRuns?: WorkflowRun[]; stale?: boolean }>()
const budget = computed(() => readWorkflowRunBudget(props.run, props.knownRuns ?? []))
</script>

<template>
  <div class="workflow-run-budget" aria-label="Laufbudget">
    <p v-if="stale">Letzter bestätigter Budgetstand – Aktualisierung ausstehend.</p>
    <p v-if="budget.boundaryStop === 'pending'" role="status">Halt angefordert – laufende Schritte abschließen.</p>
    <p v-else-if="budget.boundaryStop === 'completed'" role="status">
      Die laufenden Schritte sind beendet; der Auftrag wurde angehalten.
    </p>
    <p v-if="budget.rootUnavailable">
      Die Messwerte des übergeordneten Laufs #{{ budget.rootId }} sind noch nicht verfügbar.
    </p>
    <p v-else-if="budget.inherited">
      Gesamtbudget des übergeordneten Laufs #{{ budget.rootId }} einschließlich Unterläufen.
    </p>
    <div v-for="row in budget.rows" :key="row.key" class="workflow-budget-row">
      <span
        >{{ row.label }}: {{ row.used.toLocaleString('de-DE', { maximumFractionDigits: 1 }) }} /
        {{ row.limit.toLocaleString('de-DE', { maximumFractionDigits: 1 }) }} {{ row.unit }}</span
      >
      <progress :aria-label="row.label" :value="row.percent" max="100" />
    </div>
    <p v-if="budget.nearLimit && !isTerminalWorkflow(budget.rootStatus ?? run.status)" role="status">
      Mindestens 80 % eines Laufbudgets sind verbraucht.
    </p>
    <p v-if="budget.accountedAt">
      Servermessung: {{ new Date(budget.accountedAt).toLocaleString('de-DE') }}. Wartezeiten zählen nicht als aktive
      Laufzeit.
    </p>
    <p v-if="budget.stopReason">
      {{
        budget.stopReason === 'workflow_boundary_stop'
          ? 'Nach Abschluss der laufenden Schritte angehalten.'
          : 'Der Server meldet einen beendeten Budgetabschnitt. Details stehen im Lauf.'
      }}
    </p>
  </div>
</template>

<style scoped>
.workflow-run-budget,
.workflow-budget-row {
  display: grid;
  gap: 6px;
}
.workflow-run-budget {
  font-size: 12px;
}
.workflow-run-budget p {
  margin: 0;
  color: var(--ai-muted, #697386);
}
.workflow-budget-row progress {
  width: 100%;
  height: 6px;
  accent-color: var(--ai-accent, #7464d8);
}
</style>
