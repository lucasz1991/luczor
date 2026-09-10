<script setup lang="ts">
import { computed } from 'vue'
import AiIcon from '@/components/ai/AiIcon.vue'
import { capabilityAccess, capabilityAccessLabels, capabilityGroup, capabilityTitle } from '@/services/toolCapabilities'
import type { ToolDef } from '@/services/tools/types'
import type { LuczorMode } from '@/services/inference/types'

const props = defineProps<{ tool: ToolDef; mode: LuczorMode; killSwitch: boolean }>()
const access = computed(() => capabilityAccess(props.tool, props.mode, false, props.killSwitch))
const label = computed(() => capabilityAccessLabels[access.value])
</script>

<template>
  <article class="tool-capability-card" :data-access="access">
    <div class="tool-capability-card__icon">
      <AiIcon
        :name="
          tool.sessionKind === 'browser'
            ? 'globe'
            : tool.sessionKind === 'terminal'
              ? 'code'
              : tool.sessionKind === 'vision'
                ? 'image'
                : 'spark'
        "
        :size="15"
      />
    </div>
    <div class="tool-capability-card__body">
      <div class="tool-capability-card__top">
        <strong>{{ capabilityTitle(tool) }}</strong
        ><span>{{ label }}</span>
      </div>
      <small>{{ capabilityGroup(tool) }} · {{ tool.capabilityKey }}</small>
      <p>{{ tool.description }}</p>
    </div>
  </article>
</template>
