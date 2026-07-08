// src/services/contextController.ts
//
// Client bridge to the server Context Controller (/api/v1/context/ask), which
// ranks + budgets memory into a small context package. Falls back to local
// memory when the server isn't used/reachable.

import { Store } from "@tauri-apps/plugin-store";
import { getApiConfig } from "@/services/api/luczorApi";
import { luczorMemory } from "@/services/memory/luczorMemory";

const SETTINGS_FILE = "luczor.settings.json";

export type ContextPackage = {
  context_id: string;
  project_id?: string;
  task_type: string;
  feature_key?: string;
  budget: { max_input_tokens: number; estimated_tokens: number };
  memory: Array<{ id?: string; content: string; type: string; staleness: string; score: number }>;
  instructions: string[];
};

async function serverTarget(): Promise<{ baseUrl: string; deviceKey: string } | null> {
  try {
    const s = await Store.load(SETTINGS_FILE);
    if (!((await s.get<boolean>("memory_use_server")) ?? true)) return null;
  } catch {
    /* ignore */
  }
  const cfg = await getApiConfig();
  return cfg.deviceKey ? { baseUrl: cfg.baseUrl, deviceKey: cfg.deviceKey } : null;
}

export async function askContext(opts: {
  projectId: string;
  query: string;
  taskType?: string;
  featureKey?: string;
  maxTokens?: number;
}): Promise<ContextPackage | null> {
  const srv = await serverTarget();
  if (!srv) return null;

  const res = await fetch(`${srv.baseUrl}/api/v1/context/ask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${srv.deviceKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      query: opts.query,
      project_id: opts.projectId,
      task_type: opts.taskType ?? "chat.general",
      feature_key: opts.featureKey,
      budget: { max_input_tokens: opts.maxTokens ?? 800 },
    }),
  });
  if (!res.ok) throw new Error(`context/ask HTTP ${res.status}`);
  return (await res.json()) as ContextPackage;
}

/**
 * Compact system note to inject. Prefers the server Context Controller
 * (ranked + budgeted), falls back to local memory recall.
 */
export async function buildPromptContext(projectId: string, query: string, limit = 5): Promise<string> {
  try {
    const pkg = await askContext({ projectId, query, maxTokens: 800 });
    if (pkg) {
      if (!pkg.memory.length) return "";
      const lines = pkg.memory.map((m) => `- ${m.content}`).join("\n");
      const instr = pkg.instructions?.length ? `\n(${pkg.instructions.join(" ")})` : "";
      return `Relevante Erinnerungen:\n${lines}${instr}`;
    }
  } catch (e) {
    console.warn("[context] server ask failed, using local:", e);
  }
  return luczorMemory.getContextForPrompt(projectId, query, limit);
}
