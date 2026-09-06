<script setup lang="ts">
import AiIcon from './AiIcon.vue'
import { statusLabels, type ActivityStep } from './types'
withDefaults(defineProps<{ tasks: ActivityStep[]; variant?: 'list' | 'capsules' }>(), { variant: 'list' })
</script>
<template>
  <ol class="ai-tasks" :class="`ai-tasks--${variant}`">
    <li v-for="(task, index) in tasks" :key="task.id" :data-status="task.status">
      <details :open="task.status === 'running'">
        <summary>
          <span class="ai-status-mark" :class="{ 'ai-spinner': task.status === 'running' }"
            ><AiIcon v-if="task.status === 'done'" name="check" :size="14" /><template
              v-else-if="task.status !== 'running'"
              >{{ index + 1 }}</template
            ></span
          ><span class="ai-task-label">{{ task.label }}</span
          ><span class="ai-badge">{{ statusLabels[task.status] }}</span>
        </summary>
        <p v-if="task.detail" class="ai-task-detail">{{ task.detail }}</p>
        <p v-else class="ai-task-detail">{{ statusLabels[task.status] }}</p>
      </details>
    </li>
  </ol>
</template>
