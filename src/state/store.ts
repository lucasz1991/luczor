import { reactive } from "vue";
import type { AppState, Id, Message } from "@/state/types";
import { DEFAULT_STATE } from "@/state/defaults";

export const state = reactive<AppState>(structuredClone(DEFAULT_STATE));

export const mutations = {
  hydrate(next: AppState) {
    // shallow merge reicht oft nicht; lieber gezielt überschreiben
    Object.assign(state, next);
  },

  addMessage(msg: Message) {
    state.messages.push(msg);
  },

  touchProject(projectId: Id) {
    const p = state.projects.find(p => p.id === projectId);
    if (p) p.updatedAt = Date.now();
  },
};
