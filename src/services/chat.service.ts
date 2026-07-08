// src/services/chat.service.ts
import type * as T from "@/state/types";
import { mutations } from "@/state/store";

/**
 * Single place for message creation/appending.
 * Uses store.ts factories so all required fields (visibility/meta/raw/parsed)
 * stay consistent and you don't drift types between UI and services.
 */

export function createUserMessage(projectId: T.Id, content: string): T.Message {
  return mutations.makeMsg("user", content, projectId);
}

export function createAssistantMessage(projectId: T.Id, content: string): T.Message {
  return mutations.makeMsg("assistant", content, projectId);
}

export function createToolBackchannelMessage(projectId: T.Id, parsed: unknown, meta?: T.MessageMeta) {
  // hidden message: persisted for context, not shown in UI
  mutations.addHiddenToolMessage(projectId, parsed, meta);
}

export function appendMessage(msg: T.Message) {
  mutations.addMessage(msg);
}

export function patchMessage(projectId: T.Id, messageId: T.Id, patch: Partial<T.Message>) {
  mutations.patchMessage(projectId, messageId, patch);
}

/**
 * Convenience: append user + placeholder assistant.
 */
export function appendUserAndPlaceholder(projectId: T.Id, userText: string) {
  const user = createUserMessage(projectId, userText);
  appendMessage(user);

  const assistant = createAssistantMessage(projectId, "");
  assistant.raw = "";
  assistant.parsed = null;
  appendMessage(assistant);

  return { user, assistant };
}
