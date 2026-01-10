import { computed } from "vue";
import { state } from "@/state/store";

const props = defineProps<{ projectId: string }>();

const messages = computed(() =>
  state.messages
    .filter(m => m.projectId === props.projectId)
    .sort((a, b) => a.createdAt - b.createdAt)
);
