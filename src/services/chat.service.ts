import type { Message, ChatRole } from "@/state/types";
import { mutations } from "@/state/store";

const uid = () =>
  crypto.randomUUID?.() ?? `m_${Math.random().toString(16).slice(2)}_${Date.now()}`;

export function createMessage(projectId: string, role: ChatRole, content: string): Message {
  return {
    id: uid(),
    projectId,
    role,
    content,
    createdAt: Date.now(),
  };
}

export function appendMessage(msg: Message) {
  mutations.addMessage(msg);
  mutations.touchProject(msg.projectId);
}
