import { createApp } from 'vue'
import WorkflowEditorIsland from '@/components/workflows/WorkflowEditorIsland.vue'
for (const element of document.querySelectorAll<HTMLElement>('[data-luczor-workflow-editor]')) {
  const stateUrl = element.dataset.stateUrl
  if (stateUrl) createApp(WorkflowEditorIsland, { stateUrl }).mount(element)
}
